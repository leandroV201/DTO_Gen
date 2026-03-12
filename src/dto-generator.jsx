import { useState, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const PRIMITIVE_TYPES = new Set(["string","number","boolean","Date","object","any","int","Int","Float","BigInt","Json","Decimal","Bytes","String","Number","Boolean","Object"]);
const PRISMA_SCALARS  = new Set(["String","Int","Float","Boolean","DateTime","Json","Bytes","Decimal","BigInt"]);
const VALIDATORS = ["@IsString()","@IsNumber()","@IsInt()","@IsBoolean()","@IsEmail()","@IsUrl()","@IsUUID()","@IsDateString()","@IsObject()","@IsArray()","@IsEnum(MyEnum)","@MinLength(3)","@MaxLength(255)","@Min(0)","@Max(100)","@Matches(/regex/)","Nenhum"];
const ORM_META = { prisma:{label:"Prisma",color:"#818cf8"}, typeorm:{label:"TypeORM",color:"#f87171"}, sequelize:{label:"Sequelize",color:"#34d399"}, drizzle:{label:"Drizzle",color:"#fbbf24"} };

// ─── Parsers ──────────────────────────────────────────────────────────────────
function detectOrm(code) {
  if (/^model\s+\w+\s*\{/m.test(code)) return "prisma";
  if (/@Entity|@Column|@PrimaryGeneratedColumn/.test(code)) return "typeorm";
  if (/extends\s+Model|DataTypes\./.test(code)) return "sequelize";
  if (/pgTable|mysqlTable|sqliteTable/.test(code)) return "drizzle";
  return null;
}

function makeField(name, type, isOptional, isArray, isRelation, isForeignKey, dbMap) {
  return { name, type, isOptional, isArray, isRelation, isForeignKey, dbMap, included: true, customExample: "", validatorOverride: "" };
}

function parsePrismaSchema(schema) {
  const models = [];
  const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
  let m;
  while ((m = modelRegex.exec(schema)) !== null) {
    models.push({ name: m[1], fields: parsePrismaFields(m[2]) });
  }
  return models;
}

function parsePrismaFields(body) {
  const fields = [];
  for (const line of body.split("\n").map(l => l.trim()).filter(Boolean)) {
    if (line.startsWith("//") || line.startsWith("@@") || line.startsWith("@")) continue;
    const m = line.match(/^(\w+)\s+([\w]+)(\[\])?\s*(\?)?/);
    if (!m) continue;
    const [,fname, ftype,,optMark] = m;
    const isArray = !!m[3], isOptional = !!optMark;
    const isId = line.includes("@id"), hasDefault = line.includes("@default") || line.includes("@updatedAt");
    if (isId && hasDefault) continue;
    if (["createdAt","updatedAt","deletedAt"].includes(fname) && hasDefault) continue;
    const isRelation = !PRISMA_SCALARS.has(ftype) && ftype !== ftype.toLowerCase();
    const isForeignKey = fname.endsWith("Id") || fname.endsWith("_id");
    const dbMap = (line.match(/@map\("([^"]+)"\)/) || [])[1] || null;
    fields.push(makeField(fname, ftype, isOptional, isArray, isRelation, isForeignKey, dbMap));
  }
  return fields;
}

function parseTypeOrmEntity(code) {
  const models = [];
  const classRegex = /(?:export\s+)?class\s+(\w+)[^{]*\{([\s\S]*)/g;
  let cm;
  while ((cm = classRegex.exec(code)) !== null) {
    const fields = [];
    const propRegex = /(\w+)(\?)?\s*:\s*([\w<>\[\]|]+)/g;
    let pm;
    while ((pm = propRegex.exec(cm[2])) !== null) {
      const [,fname,opt,fraw] = pm;
      const ftype = fraw.replace("[]",""), isArray = fraw.includes("[]");
      const skip = ["id","createdAt","updatedAt","constructor","return","this","super","string","number","boolean"];
      if (skip.includes(fname)) continue;
      fields.push(makeField(fname, ftype, !!opt, isArray, !PRIMITIVE_TYPES.has(ftype), false, null));
    }
    if (fields.length) { models.push({ name: cm[1], fields }); break; }
  }
  return models;
}

function parseSequelizeModel(code) {
  const nameMatch = code.match(/class\s+(\w+)\s+extends\s+Model/) || code.match(/define\s*\(\s*['"`](\w+)/);
  const name = nameMatch ? nameMatch[1] : "Model";
  const fields = [];
  const attrRegex = /(\w+)\s*:\s*\{[^}]*type\s*:\s*DataTypes\.(\w+)/g;
  let am;
  const tsMap = {STRING:"string",TEXT:"string",INTEGER:"number",BIGINT:"number",FLOAT:"number",DOUBLE:"number",DECIMAL:"number",BOOLEAN:"boolean",DATE:"Date",UUID:"string",JSON:"object",JSONB:"object"};
  while ((am = attrRegex.exec(code)) !== null) {
    if (["id","createdAt","updatedAt"].includes(am[1])) continue;
    fields.push(makeField(am[1], tsMap[am[2].toUpperCase()]||"string", false, false, false, false, null));
  }
  return [{ name, fields }];
}

function parseDrizzleSchema(code) {
  const models = [];
  const tableRegex = /(?:export\s+const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`](\w+)['"`]\s*,\s*\{([^}]+)\})/g;
  const tsMap = {text:"string",varchar:"string",char:"string",integer:"number",bigint:"number",serial:"number",real:"number",doublePrecision:"number",boolean:"boolean",timestamp:"Date",date:"Date",uuid:"string",json:"object",jsonb:"object"};
  let match;
  while ((match = tableRegex.exec(code)) !== null) {
    const fields = [];
    const colRegex = /(\w+):\s*(\w+)\s*\(/g;
    let dm;
    while ((dm = colRegex.exec(match[3])) !== null) {
      if (["id","createdAt","updatedAt"].includes(dm[1])) continue;
      fields.push(makeField(dm[1], tsMap[dm[2]]||"string", false, false, false, false, null));
    }
    const n = match[1];
    models.push({ name: n.charAt(0).toUpperCase()+n.slice(1).replace(/s$/,""), fields });
  }
  return models;
}

// ─── DTO Generator ────────────────────────────────────────────────────────────
function autoValidator(type) {
  return {string:"@IsString()",String:"@IsString()",number:"@IsNumber()",Float:"@IsNumber()",int:"@IsInt()",Int:"@IsInt()",boolean:"@IsBoolean()",Boolean:"@IsBoolean()",Date:"@IsDateString()",DateTime:"@IsDateString()",object:"@IsObject()",Json:"@IsObject()",Decimal:"@IsNumber()",BigInt:"@IsInt()",Bytes:"@IsString()"}[type]||null;
}

function exampleValue(name, type) {
  const m = {name:'"João Silva"',email:'"joao@exemplo.com"',phone:'"+5511999999999"',cellPhone:'"+5511999999999"',telefone:'"+5511999999999"',celular:'"+5511999999999"',password:'"s3cr3t@pass"',title:'"Meu Título"',description:'"Uma descrição detalhada"',status:'"active"',price:"9990",amount:"100",quantity:"1",url:'"https://exemplo.com"',slug:'"meu-slug"',role:'"user"',content:'"Conteúdo aqui"',city:'"São Paulo"',country:'"BR"',zipCode:'"01310-100"',notes:'"Observações"',companyId:"1",userId:"1"};
  if (m[name]) return m[name];
  if (["number","int","Int","Float","Decimal","BigInt"].includes(type)) return "1";
  if (["boolean","Boolean"].includes(type)) return "true";
  if (["Date","DateTime"].includes(type)) return '"2024-01-01T00:00:00.000Z"';
  return '"exemplo"';
}

function fieldComment(name) {
  const m = {name:"Nome completo",email:"Endereço de e-mail válido",phone:"Telefone com DDD",cellPhone:"Celular com DDD",password:"Senha do usuário",title:"Título ou nome",description:"Descrição detalhada",status:"Status atual",type:"Tipo ou classificação",price:"Valor em centavos",amount:"Valor monetário",quantity:"Quantidade",url:"URL válida",slug:"Slug amigável",role:"Papel ou permissão",companyId:"ID da empresa relacionada",userId:"ID do usuário relacionado"};
  return m[name]||`Campo ${name.replace(/([A-Z])/g," $1").toLowerCase()}`;
}

function getValidator(field) {
  if (field.validatorOverride === null) return null;
  if (field.validatorOverride && field.validatorOverride !== "Nenhum") return field.validatorOverride;
  return autoValidator(field.type);
}

function generateDto(model, dtoType) {
  const isUpdate = dtoType === "update";
  const className = isUpdate ? `Update${model.name}Dto` : `Create${model.name}Dto`;
  const activeFields = model.fields.filter(f => f.included && !f.isRelation);
  const validatorsUsed = new Set();
  let hasArray = false;

  activeFields.forEach(f => {
    const isOpt = f.isOptional || isUpdate;
    if (f.isArray) { hasArray = true; validatorsUsed.add("IsArray"); }
    if (isOpt) validatorsUsed.add("IsOptional");
    const v = getValidator(f);
    if (v && v !== "Nenhum") validatorsUsed.add(v.replace(/@(\w+)\(.*/, "$1"));
  });

  const lines = [];
  lines.push(`import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';`);
  const cleanV = [...validatorsUsed].filter(Boolean);
  if (cleanV.length) lines.push(`import { ${cleanV.join(", ")} } from 'class-validator';`);
  if (hasArray) lines.push(`import { Type } from 'class-transformer';`);
  lines.push("");
  lines.push(`export class ${className} {`);

  const swType = t => ({string:"String",String:"String",number:"Number",Float:"Number",int:"Number",Int:"Number",boolean:"Boolean",Boolean:"Boolean",Date:"String",DateTime:"String",object:"Object",Json:"Object",Decimal:"Number",BigInt:"Number"}[t]||"String");

  for (const f of activeFields) {
    const isOpt = f.isOptional || isUpdate;
    const ex = f.customExample || exampleValue(f.name, f.type);
    const sw = f.isArray ? `{ type: [${swType(f.type)}], example: ${ex} }` : `{ type: ${swType(f.type)}, example: ${ex} }`;
    const v = getValidator(f);
    lines.push(`  /**`);
    lines.push(`   * ${fieldComment(f.name)}`);
    lines.push(`   * @example ${ex}`);
    lines.push(`   */`);
    lines.push(`  ${isOpt?"@ApiPropertyOptional":"@ApiProperty"}(${sw})`);
    if (isOpt) lines.push(`  @IsOptional()`);
    if (f.isArray) lines.push(`  @IsArray()`);
    if (v && v !== "Nenhum") lines.push(`  ${v}`);
    if (f.isArray) lines.push(`  @Type(() => ${f.type})`);
    lines.push(`  ${f.name}${isOpt?"?":""}: ${f.type}${f.isArray?"[]":""};`);
    lines.push("");
  }
  lines.push("}");
  return lines.join("\n");
}

// ─── Query/Service Generator ──────────────────────────────────────────────────
function generateQueryService(model, orm, ext) {
  const n = model.name;
  const nl = n.charAt(0).toLowerCase()+n.slice(1);
  const files = {};

  // find-all.dto
  files[`dto/find-all-${nl}.dto.${ext}`] = `import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class FindAll${n}Dto {
  /**
   * Página atual (começa em 1)
   * @example 1
   */
  @ApiPropertyOptional({ type: Number, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /**
   * Itens por página
   * @example 20
   */
  @ApiPropertyOptional({ type: Number, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  /**
   * Busca textual livre
   * @example "João"
   */
  @ApiPropertyOptional({ type: String, example: 'João' })
  @IsOptional()
  @IsString()
  search?: string;
}`;

  // service
  const prismaService = `import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Create${n}Dto } from './dto/create-${nl}.dto';
import { Update${n}Dto } from './dto/update-${nl}.dto';
import { FindAll${n}Dto } from './dto/find-all-${nl}.dto';

@Injectable()
export class ${n}Service {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: Create${n}Dto) {
    return this.prisma.${nl}.create({ data: dto });
  }

  async findAll({ page = 1, limit = 20, search }: FindAll${n}Dto) {
    const skip = (page - 1) * limit;
    const where = search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' } }] }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.${nl}.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
      this.prisma.${nl}.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: number) {
    const record = await this.prisma.${nl}.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('${n} não encontrado');
    return record;
  }

  async update(id: number, dto: Update${n}Dto) {
    await this.findOne(id);
    return this.prisma.${nl}.update({ where: { id }, data: dto });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.${nl}.delete({ where: { id } });
  }
}`;

  const typeormService = `import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { ${n} } from './${nl}.entity';
import { Create${n}Dto } from './dto/create-${nl}.dto';
import { Update${n}Dto } from './dto/update-${nl}.dto';
import { FindAll${n}Dto } from './dto/find-all-${nl}.dto';

@Injectable()
export class ${n}Service {
  constructor(
    @InjectRepository(${n})
    private readonly repo: Repository<${n}>,
  ) {}

  async create(dto: Create${n}Dto) {
    const entity = this.repo.create(dto);
    return this.repo.save(entity);
  }

  async findAll({ page = 1, limit = 20, search }: FindAll${n}Dto) {
    const skip = (page - 1) * limit;
    const where = search ? [{ name: Like(\`%\${search}%\`) }] : {};
    const [data, total] = await this.repo.findAndCount({ where, skip, take: limit, order: { id: 'DESC' } });
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: number) {
    const record = await this.repo.findOneBy({ id });
    if (!record) throw new NotFoundException('${n} não encontrado');
    return record;
  }

  async update(id: number, dto: Update${n}Dto) {
    await this.findOne(id);
    await this.repo.update(id, dto as any);
    return this.findOne(id);
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.repo.delete(id);
  }
}`;

  const sequelizeService = `import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ${n} } from './${nl}.model';
import { Create${n}Dto } from './dto/create-${nl}.dto';
import { Update${n}Dto } from './dto/update-${nl}.dto';
import { FindAll${n}Dto } from './dto/find-all-${nl}.dto';

@Injectable()
export class ${n}Service {
  constructor(@InjectModel(${n}) private readonly model: typeof ${n}) {}

  async create(dto: Create${n}Dto) {
    return this.model.create(dto as any);
  }

  async findAll({ page = 1, limit = 20, search }: FindAll${n}Dto) {
    const offset = (page - 1) * limit;
    const where = search ? { name: { [Op.iLike]: \`%\${search}%\` } } : {};
    const { rows: data, count: total } = await this.model.findAndCountAll({ where, offset, limit, order: [['id', 'DESC']] });
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: number) {
    const record = await this.model.findByPk(id);
    if (!record) throw new NotFoundException('${n} não encontrado');
    return record;
  }

  async update(id: number, dto: Update${n}Dto) {
    await this.findOne(id);
    await this.model.update(dto, { where: { id } });
    return this.findOne(id);
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.model.destroy({ where: { id } });
  }
}`;

  const drizzleService = `import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDrizzle } from '@knaadh/nestjs-drizzle-pg';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, ilike } from 'drizzle-orm';
import * as schema from '../database/schema';
import { Create${n}Dto } from './dto/create-${nl}.dto';
import { Update${n}Dto } from './dto/update-${nl}.dto';
import { FindAll${n}Dto } from './dto/find-all-${nl}.dto';

@Injectable()
export class ${n}Service {
  constructor(@InjectDrizzle() private readonly db: NodePgDatabase<typeof schema>) {}

  async create(dto: Create${n}Dto) {
    const [record] = await this.db.insert(schema.${nl}s).values(dto).returning();
    return record;
  }

  async findAll({ page = 1, limit = 20, search }: FindAll${n}Dto) {
    const offset = (page - 1) * limit;
    const where = search ? ilike(schema.${nl}s.name, \`%\${search}%\`) : undefined;
    const data = await this.db.select().from(schema.${nl}s).where(where).limit(limit).offset(offset).orderBy(schema.${nl}s.id);
    return { data, page, limit };
  }

  async findOne(id: number) {
    const [record] = await this.db.select().from(schema.${nl}s).where(eq(schema.${nl}s.id, id));
    if (!record) throw new NotFoundException('${n} não encontrado');
    return record;
  }

  async update(id: number, dto: Update${n}Dto) {
    await this.findOne(id);
    const [updated] = await this.db.update(schema.${nl}s).set(dto).where(eq(schema.${nl}s.id, id)).returning();
    return updated;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.db.delete(schema.${nl}s).where(eq(schema.${nl}s.id, id));
  }
}`;

  const svcMap = { prisma: prismaService, typeorm: typeormService, sequelize: sequelizeService, drizzle: drizzleService };
  files[`${nl}.service.${ext}`] = svcMap[orm] || prismaService;

  // controller
  files[`${nl}.controller.${ext}`] = `import { Controller, Get, Post, Body, Patch, Param, Delete, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ${n}Service } from './${nl}.service';
import { Create${n}Dto } from './dto/create-${nl}.dto';
import { Update${n}Dto } from './dto/update-${nl}.dto';
import { FindAll${n}Dto } from './dto/find-all-${nl}.dto';

@ApiTags('${nl}s')
@Controller('${nl}s')
export class ${n}Controller {
  constructor(private readonly ${nl}Service: ${n}Service) {}

  @Post()
  @ApiOperation({ summary: 'Criar ${nl}' })
  @ApiResponse({ status: 201, description: '${n} criado com sucesso' })
  create(@Body() dto: Create${n}Dto) {
    return this.${nl}Service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar ${nl}s com paginação e busca' })
  findAll(@Query() query: FindAll${n}Dto) {
    return this.${nl}Service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buscar ${nl} por ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.${nl}Service.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar ${nl}' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Update${n}Dto) {
    return this.${nl}Service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover ${nl}' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.${nl}Service.remove(id);
  }
}`;

  return files;
}

// ─── Faker Seed Generator ─────────────────────────────────────────────────────
function fakerExpr(name, type) {
  const byName = {
    name:        "faker.person.fullName()",
    firstName:   "faker.person.firstName()",
    lastName:    "faker.person.lastName()",
    email:       "faker.internet.email()",
    phone:       "faker.phone.number('+55 (##) #####-####')",
    cellPhone:   "faker.phone.number('+55 (##) #####-####')",
    telefone:    "faker.phone.number('+55 (##) #####-####')",
    celular:     "faker.phone.number('+55 (##) #####-####')",
    password:    "faker.internet.password({ length: 12 })",
    title:       "faker.lorem.sentence({ min: 2, max: 5 })",
    description: "faker.lorem.paragraph()",
    content:     "faker.lorem.paragraphs(2)",
    slug:        "faker.helpers.slugify(faker.lorem.words(3))",
    url:         "faker.internet.url()",
    avatar:      "faker.image.avatar()",
    image:       "faker.image.url()",
    photo:       "faker.image.url()",
    status:      "faker.helpers.arrayElement(['active', 'inactive', 'pending'])",
    role:        "faker.helpers.arrayElement(['admin', 'user', 'manager'])",
    type:        "faker.helpers.arrayElement(['type_a', 'type_b', 'type_c'])",
    price:       "faker.number.int({ min: 100, max: 99900 })",
    amount:      "faker.number.float({ min: 1, max: 9999, fractionDigits: 2 })",
    quantity:    "faker.number.int({ min: 1, max: 100 })",
    age:         "faker.number.int({ min: 18, max: 80 })",
    rating:      "faker.number.float({ min: 1, max: 5, fractionDigits: 1 })",
    score:       "faker.number.int({ min: 0, max: 100 })",
    city:        "faker.location.city()",
    country:     "faker.location.country()",
    state:       "faker.location.state()",
    address:     "faker.location.streetAddress()",
    zipCode:     "faker.location.zipCode('########')",
    cep:         "faker.location.zipCode('########')",
    latitude:    "faker.location.latitude()",
    longitude:   "faker.location.longitude()",
    companyName: "faker.company.name()",
    cnpj:        "faker.string.numeric(14)",
    cpf:         "faker.string.numeric(11)",
    notes:       "faker.lorem.sentence()",
    comment:     "faker.lorem.sentence()",
    tag:         "faker.lorem.word()",
    color:       "faker.color.human()",
    uuid:        "faker.string.uuid()",
  };
  const lname = name.toLowerCase();
  for (const [k, v] of Object.entries(byName)) {
    if (lname === k || lname.endsWith(k) || lname.startsWith(k)) return v;
  }
  // fallback by type
  const byType = {
    string: "faker.lorem.word()", String: "faker.lorem.word()",
    number: "faker.number.int({ min: 1, max: 1000 })",
    Float:  "faker.number.float({ min: 1, max: 1000, fractionDigits: 2 })",
    int:    "faker.number.int({ min: 1, max: 1000 })",
    Int:    "faker.number.int({ min: 1, max: 1000 })",
    boolean:"faker.datatype.boolean()", Boolean:"faker.datatype.boolean()",
    Date:   "faker.date.recent({ days: 30 })",
    DateTime:"faker.date.recent({ days: 30 })",
    object: "{}",
    Json:   "{}",
    Decimal:"faker.number.float({ min: 1, max: 9999, fractionDigits: 2 })",
    BigInt: "faker.number.bigInt({ min: 1n, max: 9999n })",
  };
  return byType[type] || "faker.lorem.word()";
}

function generateSeed(model, orm, count, ext) {
  const n  = model.name;
  const nl = n.charAt(0).toLowerCase() + n.slice(1);
  const activeFields = model.fields.filter(f => f.included && !f.isRelation);

  const fieldLines = activeFields.map(f => {
    const expr = fakerExpr(f.name, f.type);
    return `      ${f.name}: ${expr},`;
  }).join("\n");

  const prismaBody = `import { PrismaClient } from '@prisma/client';
import { faker } from '@faker-js/faker';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding ${n}...');

  // Limpa registros existentes (opcional)
  await prisma.${nl}.deleteMany();

  const records = Array.from({ length: ${count} }, () => ({
${fieldLines}
  }));

  await prisma.${nl}.createMany({ data: records });

  console.log(\`✅ \${${count}} ${n}(s) criados com sucesso!\`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());`;

  const typeormBody = `import { DataSource } from 'typeorm';
import { faker } from '@faker-js/faker';
import { ${n} } from './${nl}.entity';

export async function seed${n}(dataSource: DataSource) {
  const repo = dataSource.getRepository(${n});
  console.log('🌱 Seeding ${n}...');

  await repo.delete({});

  const records = Array.from({ length: ${count} }, () =>
    repo.create({
${fieldLines}
    })
  );

  await repo.save(records);
  console.log(\`✅ \${${count}} ${n}(s) criados!\`);
}`;

  const sequelizeBody = `import { faker } from '@faker-js/faker';
import { ${n} } from './${nl}.model';

export async function seed${n}() {
  console.log('🌱 Seeding ${n}...');

  await ${n}.destroy({ where: {}, truncate: true });

  const records = Array.from({ length: ${count} }, () => ({
${fieldLines}
  }));

  await ${n}.bulkCreate(records);
  console.log(\`✅ \${${count}} ${n}(s) criados!\`);
}`;

  const drizzleBody = `import { faker } from '@faker-js/faker';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

async function main() {
  console.log('🌱 Seeding ${n}...');

  await db.delete(schema.${nl}s);

  const records = Array.from({ length: ${count} }, () => ({
${fieldLines}
  }));

  await db.insert(schema.${nl}s).values(records);
  console.log(\`✅ \${${count}} ${n}(s) criados!\`);
  await pool.end();
}

main().catch(console.error);`;

  const body = { prisma: prismaBody, typeorm: typeormBody, sequelize: sequelizeBody, drizzle: drizzleBody }[orm] || prismaBody;

  return {
    [`seed-${nl}.${ext}`]: body,
    [`seed-${nl}.readme.md`]: `# Seed — ${n}

## Instalação do Faker
\`\`\`bash
npm install @faker-js/faker --save-dev
\`\`\`

## Como rodar
\`\`\`bash
npx ts-node prisma/seed-${nl}.${ext}
# ou adicione no package.json:
# "seed": "ts-node prisma/seed-${nl}.${ext}"
\`\`\`

## Campos gerados
${activeFields.map(f => `- \`${f.name}\` (${f.type}) → \`${fakerExpr(f.name, f.type)}\``).join("\n")}
`,
  };
}

// ─── Highlight ────────────────────────────────────────────────────────────────
function highlightLine(line) {
  if (!line.trim()) return <span>&nbsp;</span>;
  if (line.trim().startsWith("//") || line.trim().startsWith("*") || line.trim().startsWith("/**") || line.trim() === "*/")
    return <span style={{color:"#546e7a",fontStyle:"italic"}}>{line}</span>;
  if (line.trim().startsWith("@ApiProperty")) return <span style={{color:"#ffb74d"}}>{line}</span>;
  if (line.trim().startsWith("@Is") || line.trim().startsWith("@Type") || line.trim().startsWith("@Min") || line.trim().startsWith("@Max") || line.trim().startsWith("@Match"))
    return <span style={{color:"#ce93d8"}}>{line}</span>;
  if (line.startsWith("import")) return <span style={{color:"#80cbc4"}}>{line}</span>;
  if (line.startsWith("export class") || line.trim() === "}") return <span style={{color:"#80deea",fontWeight:"bold"}}>{line}</span>;
  const fm = line.match(/^(\s+)(\w+)(\??):\s*(.+);$/);
  if (fm) return <span><span style={{color:"#e0e0e0"}}>{fm[1]}</span><span style={{color:"#90caf9"}}>{fm[2]}</span><span style={{color:"#ef9a9a"}}>{fm[3]}</span><span style={{color:"#e0e0e0"}}>: </span><span style={{color:"#a5d6a7"}}>{fm[4]}</span><span style={{color:"#e0e0e0"}}>;</span></span>;
  return <span style={{color:"#cfd8dc"}}>{line}</span>;
}

// ─── Examples ─────────────────────────────────────────────────────────────────
const EXAMPLES = {
  prisma:`model CompanyContact {
  id        Int      @id @default(autoincrement())
  name      String   @map("nome")
  email     String   @map("email")
  phone     String   @map("telefone") @db.VarChar(15)
  cellPhone String   @map("celular") @db.VarChar(15)
  companyId Int      @map("id_empresa")
  createdAt DateTime @default(now()) @map("data_cadastro")
  updatedAt DateTime @default(now()) @map("alterado_em")
  company   Company  @relation(fields: [companyId], references: [id])
  @@map("contatos_empresa")
}`,
  typeorm:`@Entity()
export class Contact {
  @PrimaryGeneratedColumn() id: number;
  @Column() name: string;
  @Column() email: string;
  @Column({ nullable: true }) phone?: string;
  @Column({ default: 'lead' }) status: string;
  @ManyToOne(() => Company) company: Company;
}`,
  sequelize:`const User = sequelize.define('User', {
  name: { type: DataTypes.STRING },
  email: { type: DataTypes.STRING },
  phone: { type: DataTypes.STRING },
  role: { type: DataTypes.STRING },
  active: { type: DataTypes.BOOLEAN },
});`,
  drizzle:`export const contacts = pgTable('contacts', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: text('phone'),
  companyId: integer('company_id').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});`,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function Toggle({ value, onChange, label }) {
  return (
    <div style={{display:"flex",gap:7,alignItems:"center",cursor:"pointer"}} onClick={()=>onChange(!value)}>
      <div style={{width:28,height:16,borderRadius:8,background:value?"#1565c0":"#1e2a38",border:`1px solid ${value?"#1976d2":"#263238"}`,position:"relative",transition:"all 0.2s",flexShrink:0}}>
        <div style={{position:"absolute",width:10,height:10,borderRadius:"50%",background:value?"white":"#546e7a",top:2,left:value?14:2,transition:"all 0.2s"}}/>
      </div>
      <span style={{fontSize:11,color:"#546e7a",userSelect:"none"}}>{label}</span>
    </div>
  );
}

function fileIcon(f) {
  if (f.endsWith(".md"))          return { icon:"📄", color:"#78909c" };
  if (f.startsWith("seed-"))      return { icon:"🌱", color:"#66bb6a" };
  if (f.includes(".service."))    return { icon:"⚙️",  color:"#ffb74d" };
  if (f.includes(".controller.")) return { icon:"🎮", color:"#ce93d8" };
  if (f.includes("find-all"))     return { icon:"🔍", color:"#4dd0e1" };
  return { icon:"📝", color:"#90caf9" };
}

function buildFilesForModel(model, orm, ext, includeService, includeSeed, seedCount) {
  const n  = model.name;
  const nl = n.charAt(0).toLowerCase() + n.slice(1);
  const groups = {};

  // DTOs
  groups["DTOs"] = {
    [`dto/create-${nl}.dto.${ext}`]: generateDto(model, "create"),
    [`dto/update-${nl}.dto.${ext}`]: generateDto(model, "update"),
  };

  if (includeService) {
    const svc = generateQueryService(model, orm, ext);
    groups["Service & Controller"] = {};
    groups["Query DTO"] = {};
    for (const [k, v] of Object.entries(svc)) {
      if (k.includes("find-all")) groups["Query DTO"][k] = v;
      else groups["Service & Controller"][k] = v;
    }
  }

  if (includeSeed) {
    groups["Seed (Faker)"] = generateSeed(model, orm, seedCount, ext);
  }

  return groups;
}

// ─── Export Modal ─────────────────────────────────────────────────────────────
function ExportModal({ models, currentModel, orm, onClose }) {
  const [ext, setExt]                   = useState("ts");
  const [includeService, setIncludeService] = useState(true);
  const [includeSeed, setIncludeSeed]   = useState(false);
  const [seedCount, setSeedCount]       = useState(20);
  const [exportScope, setExportScope]   = useState("current"); // "current" | "all"
  const [preview, setPreview]           = useState(null);

  const targetModels = exportScope === "all" ? models : [currentModel];

  const allGrouped = useCallback(() => {
    const result = {};
    for (const model of targetModels) {
      const groups = buildFilesForModel(model, orm, ext, includeService, includeSeed, seedCount);
      result[model.name] = groups;
    }
    return result;
  }, [targetModels, orm, ext, includeService, includeSeed, seedCount]);

  const flatFiles = useCallback(() => {
    const grouped = allGrouped();
    const flat = {};
    for (const [, groups] of Object.entries(grouped))
      for (const [, files] of Object.entries(groups))
        for (const [path, content] of Object.entries(files))
          flat[path] = content;
    return flat;
  }, [allGrouped]);

  const downloadAll = () => {
    const files = flatFiles();
    Object.entries(files).forEach(([path, content]) => {
      const blob = new Blob([content], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = path.split("/").pop();
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };

  const grouped  = allGrouped();
  const flat     = flatFiles();
  const total    = Object.keys(flat).length;

  return (
    <div style={{position:"fixed",inset:0,background:"#000000dd",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
      <div style={{background:"#0d1117",border:"1px solid #1e2a38",borderRadius:10,width:"min(780px,100%)",height:"min(600px,90vh)",display:"flex",flexDirection:"column",overflow:"hidden"}} onClick={e=>e.stopPropagation()}>

        {/* ── Header ── */}
        <div style={{padding:"13px 20px",borderBottom:"1px solid #131920",display:"flex",alignItems:"center",justifyContent:"space-between",background:"#0a0c10",flexShrink:0}}>
          <div>
            <div style={{fontFamily:"'Cabinet Grotesk',sans-serif",fontWeight:900,fontSize:15,color:"#eceff1"}}>Exportar Arquivos</div>
            <div style={{fontSize:10,color:"#37474f",marginTop:2}}>{total} arquivo{total!==1?"s":""} · ORM: {ORM_META[orm]?.label||orm}</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#546e7a",cursor:"pointer",fontSize:20,lineHeight:1,padding:"0 4px"}}>×</button>
        </div>

        {/* ── Options bar ── */}
        <div style={{padding:"10px 20px",borderBottom:"1px solid #131920",background:"#0a0c10",flexShrink:0,display:"flex",flexDirection:"column",gap:10}}>
          {/* Row 1: scope + extension */}
          <div style={{display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <span style={{fontSize:10,color:"#37474f",textTransform:"uppercase",letterSpacing:1}}>Exportar:</span>
              {[["current",`Apenas ${currentModel.name}`],["all",`Todos os models (${models.length})`]].map(([v,l])=>(
                <button key={v} onClick={()=>setExportScope(v)}
                  style={{cursor:"pointer",padding:"3px 10px",borderRadius:4,border:`1px solid ${exportScope===v?"#1565c0":"#1e2a38"}`,background:exportScope===v?"#0d2444":"transparent",color:exportScope===v?"#90caf9":"#546e7a",fontFamily:"inherit",fontSize:11}}>
                  {l}
                </button>
              ))}
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center",marginLeft:"auto"}}>
              <span style={{fontSize:10,color:"#37474f",textTransform:"uppercase",letterSpacing:1}}>Extensão:</span>
              {["ts","tsx","js","jsx"].map(e=>(
                <button key={e} onClick={()=>setExt(e)}
                  style={{cursor:"pointer",padding:"3px 10px",borderRadius:4,border:`1px solid ${ext===e?"#1565c0":"#1e2a38"}`,background:ext===e?"#0d2444":"transparent",color:ext===e?"#90caf9":"#546e7a",fontFamily:"inherit",fontSize:11}}>
                  .{e}
                </button>
              ))}
            </div>
          </div>
          {/* Row 2: toggles */}
          <div style={{display:"flex",gap:20,alignItems:"center",flexWrap:"wrap"}}>
            <Toggle value={includeService} onChange={setIncludeService} label="Service + Controller + FindAllDto"/>
            <Toggle value={includeSeed}    onChange={setIncludeSeed}    label="Seed com Faker"/>
            {includeSeed && (
              <div style={{display:"flex",gap:8,alignItems:"center",marginLeft:"auto"}}>
                <span style={{fontSize:11,color:"#546e7a"}}>Registros por model:</span>
                <input type="range" min={5} max={200} step={5} value={seedCount}
                  onChange={e=>setSeedCount(+e.target.value)}
                  style={{accentColor:"#1565c0",width:90,cursor:"pointer"}}/>
                <span style={{fontSize:12,color:"#90caf9",fontWeight:700,minWidth:26,textAlign:"right"}}>{seedCount}</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Body: file tree + preview ── */}
        <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>

          {/* File tree — organized by model → group → file */}
          <div style={{width:230,borderRight:"1px solid #131920",overflowY:"auto",padding:"8px 0",flexShrink:0}}>
            {Object.entries(grouped).map(([modelName, groups])=>(
              <div key={modelName}>
                {/* Model header (only show if multiple models) */}
                {exportScope==="all" && (
                  <div style={{padding:"6px 14px 3px",fontSize:9,color:"#37474f",textTransform:"uppercase",letterSpacing:1.5,fontFamily:"'Cabinet Grotesk',sans-serif",fontWeight:700,display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:4,height:4,borderRadius:"50%",background:ORM_META[orm]?.color||"#818cf8"}}/>
                    {modelName}
                  </div>
                )}
                {/* Groups */}
                {Object.entries(groups).map(([groupName, files])=>(
                  <div key={groupName} style={{marginBottom:4}}>
                    <div style={{padding:"4px 14px 2px",fontSize:9,color:"#263238",textTransform:"uppercase",letterSpacing:1,fontFamily:"'Cabinet Grotesk',sans-serif"}}>
                      {groupName}
                    </div>
                    {Object.keys(files).map(f=>{
                      const {icon,color} = fileIcon(f);
                      const fname = f.split("/").pop();
                      const isActive = preview === f;
                      return (
                        <div key={f} onClick={()=>setPreview(f)}
                          style={{padding:"5px 14px 5px 18px",cursor:"pointer",display:"flex",alignItems:"center",gap:6,background:isActive?"#0d2444":"transparent",borderLeft:`2px solid ${isActive?"#1565c0":"transparent"}`,transition:"all 0.1s"}}>
                          <span style={{fontSize:12,flexShrink:0}}>{icon}</span>
                          <span style={{fontSize:11,color:isActive?"#e0e0e0":color,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'JetBrains Mono',monospace"}}>{fname}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Preview pane */}
          <div style={{flex:1,overflowY:"auto",padding:"14px 18px",background:"#0a0c10",fontSize:11.5,lineHeight:1.85,fontFamily:"'JetBrains Mono',monospace"}}>
            {preview && flat[preview] ? (
              <>
                <div style={{marginBottom:12,paddingBottom:8,borderBottom:"1px solid #131920",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{...fileIcon(preview),fontSize:14}}>{fileIcon(preview).icon}</span>
                  <span style={{color:"#78909c",fontSize:11}}>{preview}</span>
                  <button onClick={()=>{navigator.clipboard.writeText(flat[preview]);}}
                    style={{marginLeft:"auto",cursor:"pointer",padding:"2px 10px",borderRadius:4,border:"1px solid #1e2a38",background:"transparent",color:"#546e7a",fontFamily:"'Cabinet Grotesk',sans-serif",fontWeight:700,fontSize:10}}>
                    Copiar
                  </button>
                </div>
                {flat[preview].split("\n").map((line,i)=>(
                  <div key={i} style={{minHeight:"1.85em",whiteSpace:"pre"}}>{highlightLine(line)}</div>
                ))}
              </>
            ) : (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",flexDirection:"column",gap:10,color:"#1e2a38"}}>
                <div style={{fontSize:32}}>👈</div>
                <div style={{fontSize:12,textAlign:"center"}}>Selecione um arquivo<br/>para visualizar o conteúdo</div>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{padding:"11px 20px",borderTop:"1px solid #131920",display:"flex",gap:8,alignItems:"center",background:"#0a0c10",flexShrink:0}}>
          <div style={{fontSize:11,color:"#37474f",marginRight:"auto",lineHeight:1.5}}>
            <span style={{color:"#546e7a",fontWeight:600}}>{total}</span> arquivo{total!==1?"s":" "} ·{" "}
            {Object.entries(grouped).map(([name])=>name).join(", ")}
          </div>
          <button onClick={onClose}
            style={{cursor:"pointer",padding:"7px 16px",borderRadius:5,border:"1px solid #1e2a38",background:"transparent",color:"#546e7a",fontFamily:"'Cabinet Grotesk',sans-serif",fontWeight:700,fontSize:12}}>
            Fechar
          </button>
          <button onClick={downloadAll}
            style={{cursor:"pointer",padding:"7px 20px",borderRadius:5,border:"none",background:"#1565c0",color:"white",fontFamily:"'Cabinet Grotesk',sans-serif",fontWeight:700,fontSize:12}}>
            ⬇ Baixar {exportScope==="all"?"Tudo":"Todos"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput]           = useState("");
  const [detectedOrm, setDetectedOrm] = useState(null);
  const [models, setModels]         = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  const [dtoType, setDtoType]       = useState("create");
  const [output, setOutput]         = useState("");
  const [copied, setCopied]         = useState(false);
  const [error, setError]           = useState("");
  const [showExport, setShowExport] = useState(false);

  const regenOutput = useCallback((mdls, selName, type) => {
    const m = mdls.find(m => m.name === selName);
    if (m) setOutput(generateDto(m, type));
  }, []);

  const analyze = useCallback(() => {
    setError("");
    const orm = detectOrm(input);
    if (!orm) { setError("Schema não reconhecido. Suporte: Prisma, TypeORM, Sequelize, Drizzle."); return; }
    let parsed = [];
    if (orm === "prisma")    parsed = parsePrismaSchema(input);
    if (orm === "typeorm")   parsed = parseTypeOrmEntity(input);
    if (orm === "sequelize") parsed = parseSequelizeModel(input);
    if (orm === "drizzle")   parsed = parseDrizzleSchema(input);
    if (!parsed.length) { setError("Nenhum model encontrado."); return; }
    setDetectedOrm(orm);
    setModels(parsed);
    setSelectedModel(parsed[0].name);
    setOutput(generateDto(parsed[0], dtoType));
  }, [input, dtoType]);

  const updateField = useCallback((modelName, fieldName, patch) => {
    setModels(prev => {
      const next = prev.map(m => m.name !== modelName ? m : { ...m, fields: m.fields.map(f => f.name === fieldName ? { ...f, ...patch } : f) });
      const m = next.find(m => m.name === modelName);
      if (m) setOutput(generateDto(m, dtoType));
      return next;
    });
  }, [dtoType]);

  const currentModel = models.find(m => m.name === selectedModel);

  return (
    <div style={{fontFamily:"'JetBrains Mono','Fira Code',monospace",background:"#0a0c10",height:"100vh",maxHeight:"100vh",color:"#cfd8dc",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Cabinet+Grotesk:wght@400;700;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:5px;height:5px;}
        ::-webkit-scrollbar-track{background:#0a0c10;}
        ::-webkit-scrollbar-thumb{background:#263238;border-radius:3px;}
        select{appearance:none;cursor:pointer;}
        select option{background:#1a1f2e;}
        .fade-in{animation:fadeIn 0.2s ease;}
        @keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
        .field-row{display:grid;grid-template-columns:28px 1fr 110px 200px 1fr;gap:8px;align-items:center;padding:7px 12px;border-radius:6px;transition:background 0.15s;border:1px solid transparent;}
        .field-row:hover{background:#0d1117;border-color:#1e2a38;}
        .field-row.relation{opacity:0.4;}
        .toggle{width:28px;height:16px;border-radius:8px;background:#1e2a38;border:1px solid #263238;cursor:pointer;position:relative;transition:all 0.2s;flex-shrink:0;}
        .toggle.on{background:#1565c0;border-color:#1976d2;}
        .toggle::after{content:'';position:absolute;width:10px;height:10px;border-radius:50%;background:#546e7a;top:2px;left:2px;transition:all 0.2s;}
        .toggle.on::after{background:white;left:14px;}
        .tag{font-size:10px;padding:2px 7px;border-radius:3px;font-weight:500;letter-spacing:0.5px;}
        .tag-relation{background:#1a237e22;color:#7986cb;border:1px solid #1a237e55;}
        .tag-fk{background:#1b5e2022;color:#66bb6a;border:1px solid #1b5e2055;}
        .tag-optional{background:#37474f22;color:#78909c;border:1px solid #37474f55;}
        .tag-required{background:#b71c1c22;color:#ef5350;border:1px solid #b71c1c55;}
        .input-sm{background:#0d1117;border:1px solid #1e2a38;border-radius:4px;color:#90a4ae;font-family:inherit;font-size:11px;padding:4px 8px;outline:none;width:100%;transition:border-color 0.15s;}
        .input-sm:focus{border-color:#1565c0;color:#cfd8dc;}
        .select-sm{background:#0d1117;border:1px solid #1e2a38;border-radius:4px;color:#90a4ae;font-family:inherit;font-size:11px;padding:4px 8px;outline:none;width:100%;transition:border-color 0.15s;}
        .select-sm:focus{border-color:#1565c0;}
        .btn{cursor:pointer;border:none;border-radius:5px;font-family:'Cabinet Grotesk',sans-serif;font-weight:700;font-size:12px;letter-spacing:0.3px;transition:all 0.15s;}
        .btn-primary{background:#1565c0;color:white;padding:8px 18px;}
        .btn-primary:hover{background:#1976d2;}
        .btn-sm{background:#0d1117;color:#546e7a;padding:4px 10px;font-size:10px;border:1px solid #1e2a38;}
        .btn-sm:hover{color:#90a4ae;border-color:#263238;}
        .btn-export{background:#1b2a1b;color:#66bb6a;padding:5px 12px;font-size:10px;border:1px solid #2e7d3244;}
        .btn-export:hover{background:#1f3a1f;border-color:#388e3c;}
        .orm-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:600;font-family:'Cabinet Grotesk',sans-serif;}
        .section-header{padding:10px 16px;background:#0d1117;border-bottom:1px solid #131920;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
        .section-label{font-size:9px;text-transform:uppercase;letter-spacing:2px;color:#37474f;font-family:'Cabinet Grotesk',sans-serif;font-weight:700;}
      `}</style>

      {showExport && currentModel && (
        <ExportModal models={models} currentModel={currentModel} orm={detectedOrm||"prisma"} onClose={()=>setShowExport(false)} />
      )}

      {/* Header — fixed height */}
      <div style={{background:"#0d1117",borderBottom:"1px solid #131920",padding:"12px 20px",display:"flex",alignItems:"center",gap:14,flexShrink:0}}>
        <div style={{width:30,height:30,background:"linear-gradient(135deg,#1565c0,#283593)",borderRadius:7,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>⚡</div>
        <div>
          <div style={{fontFamily:"'Cabinet Grotesk',sans-serif",fontWeight:900,fontSize:17,color:"#eceff1",letterSpacing:-0.5}}>DTO Generator</div>
          <div style={{fontSize:9,color:"#37474f",letterSpacing:1.5,textTransform:"uppercase"}}>NestJS · class-validator · Swagger</div>
        </div>
        {detectedOrm && (
          <div className="orm-chip" style={{marginLeft:"auto",background:ORM_META[detectedOrm].color+"18",color:ORM_META[detectedOrm].color,border:`1px solid ${ORM_META[detectedOrm].color}33`}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:ORM_META[detectedOrm].color}}/>
            {ORM_META[detectedOrm].label} detectado
          </div>
        )}
      </div>

      {/* 3 panels — fill remaining height */}
      <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>

        {/* Panel L — Schema Input */}
        <div style={{width:300,minWidth:220,borderRight:"1px solid #131920",display:"flex",flexDirection:"column",flexShrink:0}}>
          <div className="section-header">
            <span className="section-label">Schema</span>
            <button className="btn btn-primary" onClick={analyze}>Analisar →</button>
          </div>
          <div style={{padding:"7px 12px",background:"#0a0c10",borderBottom:"1px solid #0d1117",display:"flex",gap:5,flexWrap:"wrap"}}>
            <span style={{fontSize:9,color:"#263238",textTransform:"uppercase",letterSpacing:1,alignSelf:"center",marginRight:2}}>Ex:</span>
            {Object.entries(ORM_META).map(([k,v])=>(
              <button key={k} onClick={()=>setInput(EXAMPLES[k])}
                style={{cursor:"pointer",fontSize:10,padding:"2px 8px",borderRadius:4,border:`1px solid ${v.color}44`,color:v.color,background:v.color+"11",fontFamily:"inherit"}}>
                {v.label}
              </button>
            ))}
          </div>
          {error && <div style={{padding:"7px 14px",background:"#1a0808",borderBottom:"1px solid #2d1010",color:"#ef5350",fontSize:11,flexShrink:0}}>⚠ {error}</div>}
          {/* Scrollable textarea */}
          <textarea
            style={{flex:1,background:"#0a0c10",color:"#78909c",fontFamily:"inherit",fontSize:12,lineHeight:1.7,padding:"14px",border:"none",outline:"none",resize:"none",overflowY:"auto"}}
            value={input}
            onChange={e=>setInput(e.target.value)}
            placeholder={`Cole seu schema aqui...\n\nPrisma, TypeORM\nSequelize ou Drizzle`}
            spellCheck={false}
          />
        </div>

        {/* Panel M — Field Editor */}
        <div style={{flex:1,display:"flex",flexDirection:"column",borderRight:"1px solid #131920",minWidth:0}}>
          <div className="section-header">
            <span className="section-label">{currentModel?`Campos — ${currentModel.name}`:"Campos"}</span>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {models.length>1 && models.map(m=>(
                <button key={m.name} onClick={()=>{setSelectedModel(m.name);regenOutput(models,m.name,dtoType);}}
                  className="btn btn-sm" style={{color:selectedModel===m.name?"#90caf9":undefined,borderColor:selectedModel===m.name?"#1565c0":undefined}}>
                  {m.name}
                </button>
              ))}
              {currentModel && (
                <button className="btn btn-export" onClick={()=>setShowExport(true)}>⬇ Exportar</button>
              )}
            </div>
          </div>

          {currentModel && (
            <div style={{padding:"7px 12px",borderBottom:"1px solid #0d1117",display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
              <span style={{fontSize:10,color:"#37474f",textTransform:"uppercase",letterSpacing:1}}>Tipo:</span>
              {["create","update"].map(t=>(
                <button key={t} onClick={()=>{setDtoType(t);regenOutput(models,selectedModel,t);}}
                  className="btn btn-sm"
                  style={{color:dtoType===t?"#90caf9":undefined,borderColor:dtoType===t?"#1565c0":undefined,background:dtoType===t?"#0d2444":undefined}}>
                  {t.charAt(0).toUpperCase()+t.slice(1)}DTO
                </button>
              ))}
              <span style={{marginLeft:"auto",fontSize:10,color:"#263238"}}>
                {currentModel.fields.filter(f=>f.included&&!f.isRelation).length} ativos
              </span>
            </div>
          )}

          {currentModel && (
            <div style={{display:"grid",gridTemplateColumns:"28px 1fr 110px 200px 1fr",gap:8,padding:"5px 12px",borderBottom:"1px solid #0d1117",flexShrink:0}}>
              {["","Campo","Status","Validador","Exemplo Swagger"].map((h,i)=>(
                <span key={i} style={{fontSize:9,color:"#263238",textTransform:"uppercase",letterSpacing:1}}>{h}</span>
              ))}
            </div>
          )}

          {/* Scrollable field list */}
          <div style={{flex:1,overflowY:"auto",padding:"5px 4px"}}>
            {!currentModel ? (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",flexDirection:"column",gap:12,color:"#1e2a38"}}>
                <div style={{fontSize:36}}>◈</div>
                <div style={{fontSize:12}}>Analise um schema para editar os campos</div>
              </div>
            ) : currentModel.fields.map(field=>(
              <div key={field.name} className={`field-row ${field.isRelation?"relation":""} fade-in`}>
                <div className={`toggle ${field.included&&!field.isRelation?"on":""}`}
                  onClick={()=>!field.isRelation&&updateField(selectedModel,field.name,{included:!field.included})}
                  title={field.isRelation?"Relação — ignorada no DTO":"Incluir/excluir"}/>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:12,color:field.included&&!field.isRelation?"#90caf9":"#37474f",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {field.name}{field.isOptional&&<span style={{color:"#546e7a",marginLeft:2}}>?</span>}
                  </div>
                  <div style={{fontSize:10,color:"#37474f"}}>{field.type}{field.isArray?"[]":""}</div>
                </div>
                <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                  {field.isRelation&&<span className="tag tag-relation">relação</span>}
                  {field.isForeignKey&&<span className="tag tag-fk">FK</span>}
                  {!field.isRelation&&(field.isOptional?<span className="tag tag-optional">opcional</span>:<span className="tag tag-required">required</span>)}
                </div>
                <select className="select-sm"
                  disabled={field.isRelation||!field.included}
                  value={field.validatorOverride===null?"Nenhum":(field.validatorOverride||autoValidator(field.type)||"Nenhum")}
                  onChange={e=>updateField(selectedModel,field.name,{validatorOverride:e.target.value==="Nenhum"?null:e.target.value})}>
                  {VALIDATORS.map(v=><option key={v} value={v}>{v}</option>)}
                </select>
                <input className="input-sm"
                  disabled={field.isRelation||!field.included}
                  placeholder={exampleValue(field.name,field.type)}
                  value={field.customExample}
                  onChange={e=>updateField(selectedModel,field.name,{customExample:e.target.value})}/>
              </div>
            ))}
          </div>
        </div>

        {/* Panel R — Output */}
        <div style={{width:400,minWidth:280,display:"flex",flexDirection:"column",flexShrink:0}}>
          <div className="section-header">
            <span className="section-label">DTO Gerado</span>
            {output && (
              <button className="btn btn-sm" onClick={()=>{navigator.clipboard.writeText(output);setCopied(true);setTimeout(()=>setCopied(false),2000);}}
                style={{color:copied?"#66bb6a":undefined,borderColor:copied?"#2e7d32":undefined}}>
                {copied?"✓ Copiado":"Copiar"}
              </button>
            )}
          </div>
          {/* Scrollable output */}
          <div style={{flex:1,overflowY:"auto",padding:"14px 16px",background:"#0a0c10",fontSize:12,lineHeight:1.85}}>
            {output ? output.split("\n").map((line,i)=>(
              <div key={i} style={{minHeight:"1.85em",whiteSpace:"pre"}}>{highlightLine(line)}</div>
            )) : (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",flexDirection:"column",gap:10,color:"#1e2a38"}}>
                <div style={{fontSize:32}}>{ }</div>
                <div style={{fontSize:12,textAlign:"center"}}>Analise um schema<br/>para gerar o DTO</div>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}