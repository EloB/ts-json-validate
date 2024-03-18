import { program as cli } from "commander";
import * as path from "path";
import * as fs from "fs/promises";
import ts from "typescript";

cli
  .option("-c, --config-path <file>", "TypeScript config file", "tsconfig.json")
  .requiredOption("-f, --schema-file <file>", "TypeScript file containing the type")
  .requiredOption("-t, --type <type>", "TypeScript type name to validate json against");

cli.argument("[json...]", "Files or dash (-) for stdin");

cli.parse();

const { configPath, schemaFile, type } = cli.opts<{ configPath: string, schemaFile: string; type: string; }>();

if (!schemaFile) cli.error("Missing required option --schema-file");
if (!type) cli.error("Missing required option --type");

const resolvedFullPath = path.resolve(process.cwd(), schemaFile);
const resolvedFileName = path.basename(resolvedFullPath);
const resolvedDirName = path.dirname(resolvedFullPath);

const options = (() => {
  const tsconfigPath = ts.findConfigFile(resolvedDirName, ts.sys.fileExists, configPath);
  if (!tsconfigPath) return ts.getDefaultCompilerOptions();
  const content = ts.sys.readFile(tsconfigPath);
  if (!content) cli.error(`Failed to read config file: ${tsconfigPath}`);
  const parsed = ts.parseConfigFileTextToJson(tsconfigPath, content);
  if (parsed.error) cli.error(`Failed to parse config file: ${tsconfigPath}`);
  return ts.parseJsonConfigFileContent(parsed.config, ts.sys, resolvedDirName).options;
})();

const host = ts.createCompilerHost(options, true);
const { readFile } = host;

const files = cli.args.map((file) => path.resolve(process.cwd(), file));
const filesMapper = Object.fromEntries(files.map((file, index) => [path.join(resolvedDirName, `__TMP_TS_JSON_${index}-${resolvedFileName}`), file]));

const generateFile = (data: any) => `\
import type { ${type} as __TS_JSON_SCHEMA } from ${JSON.stringify(`./${resolvedFileName}`)};

(${JSON.stringify(data)}) satisfies __TS_JSON_SCHEMA;
`;

host.readFile = function(fileName) {
  const newFileName = filesMapper[fileName] ?? fileName;
  if (!filesMapper[fileName]) return readFile.call(this, fileName);
  const content = readFile.call(this, filesMapper[fileName]);
  try {
    return generateFile(JSON.parse(content ?? ""));
  } catch {
    cli.error(`Failed to parse JSON from file: ${filesMapper[fileName]}`);
  }
};

const program = ts.createProgram(Object.keys(filesMapper), options, host);

const errors = program
  .getSemanticDiagnostics()
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  .reduce((obj, diagnostic) => {
    const list = obj[filesMapper[diagnostic.file?.fileName as any] ?? "unknown"] ??= [];
    list.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n", 0));
    return obj;
  }, {} as Record<string, string[]>);

if (Object.keys(errors).length) {
  const message = Object.entries(errors).map(([file, errors]) => `${path.relative(process.cwd(), file)}\n${errors.join("\n")}`).join("\n\n");
  cli.error(`Error:\n\n${message}`);
}

console.log("All files are valid JSON for the given type! 🎉");
