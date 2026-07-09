import { ZRODE_MARK_PATHS, ZRODE_MARK_VIEWBOX_SIZE } from "@t3tools/shared/brand";
import type { SVGProps } from "react";

import { APP_BASE_NAME, APP_STAGE_LABEL } from "../branding";
import { cn } from "../lib/utils";

export function ZrodeMarkIcon({
  className,
  strokeWidth = 36,
  title,
  ...props
}: SVGProps<SVGSVGElement> & { readonly title?: string; readonly strokeWidth?: number }) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      fill="none"
      role={title ? "img" : undefined}
      viewBox={`0 0 ${ZRODE_MARK_VIEWBOX_SIZE} ${ZRODE_MARK_VIEWBOX_SIZE}`}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {ZRODE_MARK_PATHS.map((path) => (
        <path
          d={path}
          key={path}
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth={strokeWidth}
        />
      ))}
    </svg>
  );
}

export function BrandWordmark({
  className,
  markClassName,
  showStage = true,
  stageClassName,
  stageLabel = APP_STAGE_LABEL,
  textClassName,
}: {
  readonly className?: string;
  readonly markClassName?: string;
  readonly showStage?: boolean;
  readonly stageClassName?: string;
  readonly stageLabel?: string;
  readonly textClassName?: string;
}) {
  return (
    <span
      aria-label={APP_BASE_NAME}
      className={cn("inline-flex min-w-0 items-center gap-1", className)}
    >
      <ZrodeMarkIcon className={cn("size-5 text-foreground", markClassName)} />
      <span
        className={cn(
          "min-w-0 truncate text-sm font-medium uppercase text-muted-foreground",
          textClassName,
        )}
      >
        {APP_BASE_NAME.toUpperCase()}
      </span>
      {showStage ? (
        <span
          className={cn(
            "shrink-0 items-center whitespace-nowrap rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60",
            stageClassName,
          )}
        >
          {stageLabel}
        </span>
      ) : null}
    </span>
  );
}
