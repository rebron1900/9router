import { TABLES } from "../schema.js";

export default {
  version: 3,
  name: "standard-model-order",
  up(db) {
    const columns = db.all("PRAGMA table_info(standardModels)");
    if (!columns.some((column) => column.name === "sortOrder")) {
      db.exec(`ALTER TABLE standardModels ADD COLUMN sortOrder ${TABLES.standardModels.columns.sortOrder}`);
    }

    // Preserve the existing registration order for installations created before
    // the catalog order field existed. New rows are assigned after the current max.
    db.run("UPDATE standardModels SET sortOrder = rowid WHERE sortOrder = 0");
  },
};
