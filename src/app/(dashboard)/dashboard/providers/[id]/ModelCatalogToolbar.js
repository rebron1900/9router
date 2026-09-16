import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";

const FILTERS = [
  { value: "all", label: "All models" },
  { value: "active", label: "Active" },
  { value: "custom", label: "Custom" },
  { value: "live", label: "Live" },
  { value: "hidden", label: "Hidden" },
];

export default function ModelCatalogToolbar({ query, onQueryChange, filter, onFilterChange, counts }) {
  const total = counts.all || 0;
  const visible = counts.visible ?? total;

  return (
    <div className="mb-3 rounded-xl border border-border/70 bg-sidebar/25 p-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{translate("Search models")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={translate("Search model name or ID")}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-text-muted/70 focus:border-primary"
          />
        </label>
        <select
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          aria-label={translate("Filter models")}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        >
          {FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {translate(option.label)}{counts[option.value] != null ? ` (${counts[option.value]})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
        <span>{visible} {translate("shown")}</span>
        <span>{total} {translate("total")}</span>
        {counts.live > 0 && <span className="text-blue-600 dark:text-blue-400">{counts.live} {translate("from live catalog")}</span>}
        {counts.hidden > 0 && <span>{counts.hidden} {translate("hidden")}</span>}
      </div>
    </div>
  );
}

ModelCatalogToolbar.propTypes = {
  query: PropTypes.string.isRequired,
  onQueryChange: PropTypes.func.isRequired,
  filter: PropTypes.oneOf(FILTERS.map((item) => item.value)).isRequired,
  onFilterChange: PropTypes.func.isRequired,
  counts: PropTypes.shape({
    all: PropTypes.number,
    active: PropTypes.number,
    custom: PropTypes.number,
    live: PropTypes.number,
    hidden: PropTypes.number,
    visible: PropTypes.number,
  }).isRequired,
};
