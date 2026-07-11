import { useRef, useState, type PointerEvent } from "react";

import { ZrodeMarkIcon } from "./BrandWordmark";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

export function NoActiveThreadState() {
  const [logoTurns, setLogoTurns] = useState(0);
  const [logoOffset, setLogoOffset] = useState({ x: 0, y: 0 });
  const [isDraggingLogo, setIsDraggingLogo] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const didDragRef = useRef(false);
  const handleLogoPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    didDragRef.current = false;
    setIsDraggingLogo(true);
  };

  const handleLogoPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!isDraggingLogo || !event.isPrimary) return;

    const x = event.clientX - dragStartRef.current.x;
    const y = event.clientY - dragStartRef.current.y;
    if (Math.hypot(x, y) > 3) didDragRef.current = true;
    setLogoOffset({ x, y });
  };

  const releaseLogo = () => {
    setIsDraggingLogo(false);
    setLogoOffset({ x: 0, y: 0 });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-x-hidden bg-background">
        <Empty>
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <button
                aria-label="Drag or spin the Zrode logo"
                className={
                  isDraggingLogo
                    ? "mb-8 cursor-grabbing touch-none text-foreground outline-none transition-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                    : "mb-8 cursor-grab touch-none text-foreground outline-none transition-transform duration-500 ease-[cubic-bezier(.34,1.56,.64,1)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none"
                }
                onClick={() => {
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  setLogoTurns((turns) => turns + 1);
                }}
                onPointerCancel={releaseLogo}
                onPointerDown={handleLogoPointerDown}
                onPointerMove={handleLogoPointerMove}
                onPointerUp={releaseLogo}
                style={{ transform: `translate3d(${logoOffset.x}px, ${logoOffset.y}px, 0)` }}
                type="button"
              >
                <ZrodeMarkIcon
                  className="size-14 transition-transform duration-700 ease-out motion-reduce:transition-none sm:size-16"
                  style={{ transform: `rotate(${logoTurns * 360}deg)` }}
                />
              </button>
              <EmptyTitle className="text-foreground text-xl">Pick a thread to continue</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
