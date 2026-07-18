export interface TerminalSelectionWheelState {
  remainder: number;
}

interface TerminalSelectionWheelInput {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly rows: number;
  readonly cellHeight: number;
}

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Converts wheel distance to whole terminal rows while preserving trackpad fractions. */
export function consumeTerminalSelectionWheelRows(
  state: TerminalSelectionWheelState,
  input: TerminalSelectionWheelInput,
): number {
  if (!Number.isFinite(input.deltaY) || input.deltaY === 0) return 0;

  const rows = Number.isFinite(input.rows) && input.rows > 0 ? input.rows : 1;
  const cellHeight =
    Number.isFinite(input.cellHeight) && input.cellHeight > 0 ? input.cellHeight : 1;

  const rowDelta =
    input.deltaMode === DOM_DELTA_LINE
      ? input.deltaY
      : input.deltaMode === DOM_DELTA_PAGE
        ? input.deltaY * rows
        : input.deltaY / cellHeight;
  const accumulated = (Number.isFinite(state.remainder) ? state.remainder : 0) + rowDelta;
  const wholeRows = accumulated < 0 ? Math.ceil(accumulated) : Math.floor(accumulated);
  state.remainder = accumulated - wholeRows;
  return wholeRows;
}
