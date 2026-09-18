import { execute } from './executor.js';
import { parse } from './parser.js';

export const createDatabase = () => {
  const tables = new Map();

  const db = {
    createTable(name, columns) {
      tables.set(name.toLowerCase(), { name: name.toLowerCase(), columns: columns.map((c) => ({ name: c.name.toLowerCase(), type: c.type })), rows: [] });
      return db;
    },

    insert(name, rows) {
      const table = tables.get(name.toLowerCase());
      if (!table) throw new Error('unknown table ' + name);
      for (const raw of rows) {
        const row = {};
        for (const column of table.columns) row[column.name] = raw[column.name] === undefined ? null : raw[column.name];
        table.rows.push(row);
      }
      return db;
    },

    query(sql) {
      return execute(db, parse(sql));
    },

    schema() {
      return Object.fromEntries([...tables.values()].map((t) => [t.name, t.columns.map((c) => ({ ...c }))]));
    },

    rows(name) {
      const table = tables.get(name.toLowerCase());
      if (!table) throw new Error('unknown table ' + name);
      return table.rows;
    },
  };

  return db;
};
