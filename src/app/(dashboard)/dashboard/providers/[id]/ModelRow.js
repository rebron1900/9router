import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";
import { translate } from "@/i18n/runtime";

function InlineIcon({ name, className = "" }) {
  if (name === "spinner") {
    return <span aria-hidden="true" className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
  }

  const paths = {
    test: <><path d="M9 2h6" /><path d="M10 2v5l-4.2 7.5A2 2 0 0 0 7.5 18h9a2 2 0 0 0 1.7-3.5L14 7V2" /><path d="M8 13h8" /></>,
    copy: <><rect x="8" y="8" width="10" height="10" rx="1.5" /><path d="M6 14H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    error: <><circle cx="12" cy="12" r="8.5" /><path d="m9 9 6 6M15 9l-6 6" /></>,
    model: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.5 7.5 7.5 4.2 7.5-4.2M12 11.7V21" /></>,
    trash: <><path d="M4 7h16" /><path d="M10 11v5M14 11v5" /><path d="m6 7 1 12h10l1-12M9 7V4h6v3" /></>,
    disable: <><path d="M3 3l18 18" /><path d="M10.6 10.6A2 2 0 0 0 13.4 13.4" /><path d="M9.9 4.2A10.5 10.5 0 0 1 12 4c5 0 8.5 4 9 8-.2 1.4-.8 2.6-1.7 3.8" /><path d="M6.7 6.7C4.8 8 3.4 9.8 3 12c.5 4 4 8 9 8 1.2 0 2.3-.2 3.3-.6" /></>,
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  };

  return (
    <svg aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name] || null}
    </svg>
  );
}

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, isLive, isDisabled, onDeleteAlias, onTest, isTesting, onDisable, onRestore, caps, thinkingSuffix, removeLabel, sourceLabel }) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  return (
    <div className={`group min-w-0 max-w-full rounded-lg border px-3 py-2 ${borderColor} ${isDisabled ? "opacity-60" : ""} hover:bg-sidebar/50`}>
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <InlineIcon
          name={testStatus === "ok" ? "check" : testStatus === "error" ? "error" : "model"}
          className={testStatus === "ok" ? "text-green-500" : testStatus === "error" ? "text-red-500" : "text-text-muted"}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code
            title={displayModel}
            className="block h-5 max-w-[72vw] truncate whitespace-nowrap rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs leading-4 text-text-muted sm:max-w-[360px]"
          >
            {displayModel}
          </code>
          <span className="flex min-h-4 min-w-0 items-center gap-1 pl-1 text-[9px]">
            {model.name && model.name !== model.id && (
              <span className="group/model-name relative min-w-0 max-w-full">
                <span title={model.name} className="block max-w-full truncate text-[9px] italic text-text-muted/70">{model.name}</span>
                <span className="pointer-events-none absolute bottom-full left-0 z-30 mb-1 hidden max-w-[min(80vw,420px)] whitespace-normal break-words rounded-md border border-border bg-background px-2 py-1 text-[10px] not-italic leading-4 text-text-main shadow-lg group-hover/model-name:block group-focus-within/model-name:block">
                  {model.name}
                </span>
              </span>
            )}
            {sourceLabel && <span className="shrink-0 rounded-full bg-sidebar px-1.5 py-0.5 text-[8px] font-medium not-italic text-text-muted">{translate(sourceLabel)}</span>}
            {isLive && <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[8px] font-medium not-italic text-blue-600 dark:text-blue-400">{translate("Live")}</span>}
            <CapacityBadges caps={caps} colorOverride="text-text-muted/70" size={12} />
          </span>
        </div>
        {onTest && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={onTest}
              disabled={isTesting}
              aria-label={translate(isTesting ? "Testing model" : "Test model")}
              title={translate(isTesting ? "Testing..." : "Test model")}
              className="rounded p-1 text-text-muted transition-colors hover:bg-sidebar hover:text-primary disabled:cursor-wait disabled:opacity-70"
            >
              <InlineIcon name={isTesting ? "spinner" : "test"} />
            </button>
          </div>
        )}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => onCopy(displayModel, `model-${model.id}`)}
            aria-label={translate(copied === `model-${model.id}` ? "Copied" : "Copy model id")}
            title={translate(copied === `model-${model.id}` ? "Copied" : "Copy model id")}
            className="rounded p-1 text-text-muted hover:bg-sidebar hover:text-primary"
          >
            <InlineIcon name={copied === `model-${model.id}` ? "check" : "copy"} />
          </button>
        </div>
        {isDisabled && onRestore ? (
          <button
            type="button"
            onClick={onRestore}
            aria-label={translate("Show model")}
            title={translate("Show model")}
            className="ml-auto rounded p-1 text-text-muted transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <InlineIcon name="eye" />
          </button>
        ) : (onDisable || isCustom) ? (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {onDisable && (
              <button
                type="button"
                onClick={onDisable}
                aria-label={translate("Hide this model")}
                title={translate("Hide this model")}
                className="rounded p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
              >
                <InlineIcon name="disable" />
              </button>
            )}
            {isCustom && (
              <button
                type="button"
                onClick={onDeleteAlias}
                aria-label={translate(removeLabel || "Remove custom model")}
                title={translate(removeLabel || "Remove custom model")}
                className="rounded p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
              >
                <InlineIcon name="trash" />
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  isLive: PropTypes.bool,
  isDisabled: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  onRestore: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
  removeLabel: PropTypes.string,
  sourceLabel: PropTypes.string,
};
