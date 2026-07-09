import { ZRODE_MARK_PATHS, ZRODE_MARK_VIEWBOX_SIZE } from "@t3tools/shared/brand";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "./AppText";
import { useThemeColor } from "../lib/useThemeColor";

function ZrodeLogo(props: { readonly size: number }) {
  const markColor = String(useThemeColor("--color-foreground"));

  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${ZRODE_MARK_VIEWBOX_SIZE} ${ZRODE_MARK_VIEWBOX_SIZE}`}
      fill="none"
    >
      {ZRODE_MARK_PATHS.map((path) => (
        <Path key={path} d={path} stroke={markColor} strokeLinejoin="round" strokeWidth={36} />
      ))}
    </Svg>
  );
}

export function BrandMark(props: { readonly compact?: boolean; readonly stageLabel?: string }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel = props.stageLabel ?? "Alpha";

  return (
    <View className="flex-row items-center gap-2">
      <ZrodeLogo size={iconSize} />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-lg font-t3-bold text-foreground" style={{ letterSpacing: 0 }}>
            ZRODE
          </Text>
          <View className="rounded-full bg-subtle px-2 py-1">
            <Text
              className="text-3xs font-t3-bold uppercase text-foreground-muted"
              style={{ letterSpacing: 1.1 }}
            >
              {stageLabel}
            </Text>
          </View>
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}
