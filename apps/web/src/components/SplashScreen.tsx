import { ZrodeMarkIcon } from "./BrandWordmark";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="Zrode splash screen">
        <ZrodeMarkIcon className="size-16 text-foreground" title="Zrode" />
      </div>
    </div>
  );
}
