import * as fs from 'fs';
import * as path from 'path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { SchoolConfigFileSchema } from './schema';

function generateJsonSchema() {
  const jsonSchema = zodToJsonSchema(SchoolConfigFileSchema as any, 'SchoolConfigFile');
  const targetDir = path.resolve(process.cwd(), 'config');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const targetFile = path.join(targetDir, 'schema.json');
  fs.writeFileSync(targetFile, JSON.stringify(jsonSchema, null, 2), 'utf-8');
  console.log(`[Schema Generator] Generated: ${targetFile}`);
}

generateJsonSchema();
