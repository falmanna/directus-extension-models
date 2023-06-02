import {defineHook} from '@directus/extensions-sdk';
import pluralize from 'pluralize';
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {Command} from "commander";
import type {CollectionsOverview, FieldOverview, SchemaOverview} from "@directus/shared/types";

type Collection = CollectionsOverview[''];

function upperCamelCase(value: string) {
    return value.split('_')
        .map(part => part[0].toUpperCase() + part.substring(1).toLowerCase())
        .join('');
}

function className(collection: Collection): string {
    const plural = collection.collection;
    const singular = pluralize.singular(plural);
    return upperCamelCase(singular);
}

function fieldToRelationType(field: FieldOverview, collection: Collection, schema: SchemaOverview): string[] | null {
    const relation = schema.relations.find(r => r.collection === collection.collection && r.field === field.field);
    if (!relation) {
        return null;
    }

    const targetClassName = className(schema.collections[relation.related_collection]);
    const keyType = relation?.schema?.foreign_key_column ?
        // There is a foreign key, so we can use readable names
        `${targetClassName}["${relation.schema.foreign_key_column}"]` :
        // No foreign key, so let's just use the field type
        fieldTypeToJsType(field, collection);

    if (targetClassName === className(collection)) {
        // self reference so no import
        return [`${targetClassName} | ${keyType}`];
    } else {
        // import referenced type
        return [
            `${targetClassName} | ${keyType}`,
            `import { ${targetClassName} } from "./${targetClassName}";`
        ];
    }
}

function aliasToType(field: FieldOverview, collection: Collection, schema: SchemaOverview): string[] | null {
    const relation = schema.relations.find(r => r?.meta?.one_collection === collection.collection && r?.meta?.one_field);
    if (!relation) {
        return null;
    }
    const targetClassName = className(schema.collections[relation.meta.many_collection]);
    if (targetClassName === className(collection)) {
        // this is a self-reference, so no self-import needed
        return [targetClassName];
    } else {
        // also add the import
        return [
            `${targetClassName}[]`,
            `import { ${targetClassName} } from "./${targetClassName}";`
        ];
    }
}

function fieldTypeToJsType(field: FieldOverview, collection: Collection): string {
    switch (field.type) {
        case"boolean":
            return "boolean";
        case "integer":
        case "float":
        case "decimal":
        case "bigInteger":
            return "number";
        case "dateTime":
        case"date":
        case "time":
        case "timestamp":
            // TODO: Validate this
            return "string";
        case "text":
        case "string":
        case "uuid":
        case "hash":
            return 'string';
        case "json":
            return "any";
        case "csv":
            return "string[]";
        case "alias":
        case "binary":
        case "geometry":
        case "geometry.Point":
        case "geometry.LineString":
        case "geometry.Polygon":
        case "geometry.MultiPoint":
        case "geometry.MultiLineString":
        case "geometry.MultiPolygon":
        case "unknown":
        default:
            throw new Error('Unknown type');
    }
}

async function generateModel(collection: Collection, schema: SchemaOverview, services, database): Promise<string> {
    let imports = [];
    let source = `export interface ${className(collection)} {\n`;

    const fieldsService = new services.ItemsService('directus_fields', {
        knex: database,
        schema
    });

    for (const field of Object.values(collection.fields)) {
        let type: string;
        try {
            // This might be a relation
            let relation = field.alias ? aliasToType(field, collection, schema) : fieldToRelationType(field, collection, schema);
            if (relation) {
                type = relation[0];
                relation.slice(1).forEach(importLine => {
                    if (!imports.includes(importLine)) {
                        imports.push(importLine);
                    }
                });
            } else {
                // Or this might be an enum
                const fieldItem = (await fieldsService.readByQuery({
                    filter: {
                        collection: {
                            _eq: collection.collection
                        },
                        field: {
                            _eq: field.field
                        }
                    },
                    limit: 1
                }))[0];
                if (fieldItem?.options?.choices?.length) {
                    // this is an enum with fixed choices!
                    type = fieldItem?.options?.choices
                        ?.map(choice => `'${choice.value.replaceAll('\'', '\\\'')}'`)
                        ?.join(' | ')
                } else {
                    // this may just be a plain type
                    type = fieldTypeToJsType(field, collection);
                }
            }
            if (field.nullable) {
                type = `${type} | null`;
            }
        } catch (e) {
            console.error(`
== Missing Field ==
Failed to get the type for ${collection.collection}.${field.field}. Setting to "never".
Please report this error: https://github.com/ChappIO/directus-extension-models/issues.


Stack Trace:`, e, `

Model generation will still continue, no worries.
`);
            type = 'never';
        }
        source += `
  /**
   * ${field.note || 'No description.'}
   *
   * Type in directus: ${field.type}
   * Type in database: ${field.dbType || 'no column'}
   */
   ${field.field}: ${type};\n`
    }

    source += '}\n'

    let importsSource = imports.map(importLine => `${importLine}\n`).join('');
    if (imports) {
        importsSource += "\n";
    }

    return `${importsSource}${source}`
}

function generateIndex(collections: CollectionsOverview): string {
    let source = ``;
    Object.values(collections).map((collection: Collection) => {
        source += `import { ${className(collection)} } from "./${className(collection)}";\n`
    });

    source += '\nexport interface Collections {\n';
    Object.values(collections).forEach((collection: Collection) => {
        source += `  ${collection.collection}: ${className(collection)};\n`
    });
    source += '}\n';
    return source;
}

export default defineHook(async ({init}, {services, getSchema, database, logger}) => {
    init('cli.after', ({program}: any) => {

        const modelTypesCommand: Command = program.command('models')
            .description('Export the currently connected database to .d.ts files');

        modelTypesCommand
            .command('snapshot')
            .description('Export the currently connected database to .d.ts files into the <directory>')
            .arguments('<directory>')
            .action(async function (targetDirectory: string) {
                const schema = await getSchema();
                const collections = schema.collections;
                logger.info(`Exporting models to ${targetDirectory}`);

                await mkdir(targetDirectory, {
                    recursive: true,
                });

                // Generate all classes
                for (let collection of Object.values(collections)) {
                    const outFile = join(targetDirectory, className(collection) + '.d.ts');
                    await writeFile(outFile, await generateModel(collection, schema, services, database));
                }

                // Generate the index
                await writeFile(join(targetDirectory, 'index.d.ts'), generateIndex(collections));
                process.exit(0);
            });
    });
});