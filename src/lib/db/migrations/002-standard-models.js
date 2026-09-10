import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "standard-models",
  up(db) {
    for (const name of ["standardModels", "standardModelProviders", "standardModelMappings"]) {
      const def = TABLES[name];
      db.exec(buildCreateTableSql(name, def));
      for (const idx of def.indexes || []) db.exec(idx);
    }
  },
};
