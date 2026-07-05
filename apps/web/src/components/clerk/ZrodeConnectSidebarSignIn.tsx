import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon, SmartphoneIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { useZrodeConnectAuthPrompt } from "./useZrodeConnectAuthPrompt";

export function ZrodeConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredZrodeConnectSidebarSignIn />;
}

export function ZrodeConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredZrodeConnectSidebarAvatar />;
}

function ConfiguredZrodeConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-accent",
        },
      }}
    >
      <UserButton.UserProfilePage
        label="Mobile clients"
        labelIcon={<SmartphoneIcon className="size-4" />}
        url="mobile-clients"
      >
        <MobileClientsUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}

function ConfiguredZrodeConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useZrodeConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={openAuthPrompt}
          >
            <LogInIcon className="size-4" />
            <span>Sign in to Zrode Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
