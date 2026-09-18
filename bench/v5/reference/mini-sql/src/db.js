import { SqlSemanticError } from './errors.js';
import { execute } from './executor.js';
import { parse } from './parser.js';

const TYPES = new Set(['int', 'float', 'text']);
const keyOf = (v) => (v === null ? '#null' : `${typeof v}:${String(v)}`);

export const createDatabase = () => {
  const tables = new Map();

  const get = (name) => {
    const table = tables.get(String(name).toLowerCase());
    if (!table) throw new SqlSemanticError(`unknown table ${name}`);
    return table;
  };

  const coerce = (table, column, value) => {
    if (value === undefined || value === null) return null;
    if (column.type === 'text') {
      if (typeof value !== 'string') throw new SqlSemanticError(`${table.name}.${column.name} expects text`);
      return value;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new SqlSemanticError(`${table.name}.${column.name} expects a finite number`);
    if (column.type === 'int' && !Number.isInteger(value)) throw new SqlSemanticError(`${table.name}.${column.name} expects an integer`);
    return value;
  };

  const db = {
    createTable(name, columns) {
      const key = String(name).toLowerCase();
      if (tables.has(key)) throw new SqlSemanticError(`table ${name} already exists`);
      if (!Array.isArray(columns) || columns.length === 0) throw new SqlSemanticError(`table ${name} needs at least one column`);
      const defined = columns.map((c) => {
        if (!c || typeof c.name !== 'string' || !TYPES.has(c.type)) throw new SqlSemanticError(`column definitions need { name, type: int|float|text }`);
        return { name: c.name.toLowerCase(), type: c.type };
      });
      if (new Set(defined.map((c) => c.name)).size !== defined.length) throw new SqlSemanticError(`table ${name} has duplicate column names`);
      tables.set(key, { name: key, columns: defined, rows: [], indexes: new Map() });
      return db;
    },

    insert(name, rows) {
      const table = get(name);
      for (const raw of rows) {
        for (const given of Object.keys(raw)) {
          if (!table.columns.some((c) => c.name === given.toLowerCase())) throw new SqlSemanticError(`unknown column ${table.name}.${given}`);
        }
        const row = {};
        for (const column of table.columns) {
          const supplied = Object.keys(raw).find((k) => k.toLowerCase() === column.name);
          row[column.name] = coerce(table, column, supplied === undefined ? null : raw[supplied]);
        }
        table.rows.push(row);
        for (const [column, buckets] of table.indexes) {
          const key = keyOf(row[column]);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(row);
        }
      }
      return db;
    },

    createIndex(name, column) {
      const table = get(name);
      const key = String(column).toLowerCase();
      if (!table.columns.some((c) => c.name === key)) throw new SqlSemanticError(`unknown column ${table.name}.${column}`);
      const buckets = new Map();
      for (const row of table.rows) {
        const k = keyOf(row[key]);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(row);
      }
      table.indexes.set(key, buckets);
      return db;
    },

    query(sql, options = {}) {
      return execute(db, parse(sql), options);
    },

    schema() {
      return Object.fromEntries([...tables.values()].map((t) => [t.name, t.columns.map((c) => ({ ...c }))]));
    },

    rows(name) {
      return get(name).rows;
    },

    hasIndex(name, column) {
      return tables.has(String(name).toLowerCase()) && get(name).indexes.has(String(column).toLowerCase());
    },

    lookup(name, column, value) {
      const buckets = get(name).indexes.get(String(column).toLowerCase());
      return buckets ? buckets.get(keyOf(value)) ?? [] : [];
    },
  };

  return db;
};
