import { randomUUID } from "node:crypto";

// A provider can expose more than one upstream model for a standard model.
// Keep one provider binding per model so the dashboard can render and edit
// every model as an independent fallback card.
const migration = {
  version: 4,
  name: "standard-model-provider-cards",
  up(db) {
    db.exec("DROP INDEX IF EXISTS idx_smp_model_provider");
    db.exec("CREATE INDEX IF NOT EXISTS idx_smp_model_provider ON standardModelProviders(standardModelId, providerId)");

    const bindings = db.all(
      "SELECT * FROM standardModelProviders ORDER BY standardModelId, priority ASC, createdAt ASC, id ASC",
    );

    for (const binding of bindings) {
      const mappings = db.all(
        "SELECT * FROM standardModelMappings WHERE providerBindingId = ? ORDER BY mappingPriority ASC, createdAt ASC, id ASC",
        [binding.id],
      );
      if (mappings.length <= 1) continue;

      // Keep the first mapping on the original binding and move the rest to
      // cloned bindings. Mapping rows retain their IDs and metadata.
      mappings.slice(1).forEach((mapping, index) => {
        const clonedBindingId = randomUUID();
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO standardModelProviders
            (id, standardModelId, providerId, enabled, priority, weight, data, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            clonedBindingId,
            binding.standardModelId,
            binding.providerId,
            binding.enabled,
            Number(binding.priority) + index + 1,
            binding.weight,
            "{}",
            binding.createdAt || now,
            now,
          ],
        );
        db.run(
          "UPDATE standardModelMappings SET providerBindingId = ?, mappingPriority = 1, updatedAt = ? WHERE id = ?",
          [clonedBindingId, now, mapping.id],
        );
      });
      db.run("UPDATE standardModelMappings SET mappingPriority = 1 WHERE providerBindingId = ?", [binding.id]);
    }

    // Re-number the visible fallback cards per standard model after cloning.
    const standardModelIds = db.all("SELECT DISTINCT standardModelId FROM standardModelProviders");
    for (const { standardModelId } of standardModelIds) {
      const modelBindings = db.all(
        "SELECT id FROM standardModelProviders WHERE standardModelId = ? ORDER BY priority ASC, createdAt ASC, id ASC",
        [standardModelId],
      );
      modelBindings.forEach((row, index) => {
        db.run("UPDATE standardModelProviders SET priority = ? WHERE id = ?", [index + 1, row.id]);
      });
    }
  },
};

export default migration;
