import { View } from "react-native";

/* Small drawn devices instead of generic glyphs: an iPhone with its Dynamic
   Island and a lit screen, and a MacBook with a lit display on its base.
   The screens carry the brand teal so the pair reads as "LilOS on both". */

const SCREEN = {
  experimental_backgroundImage: [
    {
      type: "linear-gradient" as const,
      direction: "to bottom right",
      colorStops: [{ color: "#5fd6ce" }, { color: "#0f766e" }],
    },
  ],
};

export function PhoneArt({ scale = 1 }: { scale?: number }) {
  const w = 30 * scale;
  const h = 58 * scale;
  return (
    <View
      style={{
        width: w,
        height: h,
        borderRadius: 8 * scale,
        padding: 2.5 * scale,
        backgroundColor: "#1c1c1e",
        borderCurve: "continuous",
      }}
    >
      <View
        style={{
          flex: 1,
          borderRadius: 6 * scale,
          alignItems: "center",
          paddingTop: 3 * scale,
          borderCurve: "continuous",
          ...SCREEN,
        }}
      >
        <View
          style={{
            width: 9 * scale,
            height: 3 * scale,
            borderRadius: 2 * scale,
            backgroundColor: "#1c1c1e",
          }}
        />
      </View>
    </View>
  );
}

export function MacArt({ scale = 1 }: { scale?: number }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View
        style={{
          width: 64 * scale,
          height: 42 * scale,
          borderTopLeftRadius: 5 * scale,
          borderTopRightRadius: 5 * scale,
          borderBottomLeftRadius: 1.5 * scale,
          borderBottomRightRadius: 1.5 * scale,
          padding: 2.5 * scale,
          paddingTop: 3.5 * scale,
          backgroundColor: "#1c1c1e",
        }}
      >
        <View style={{ flex: 1, borderRadius: 2 * scale, ...SCREEN }} />
      </View>
      <View
        style={{
          width: 80 * scale,
          height: 5 * scale,
          borderBottomLeftRadius: 4 * scale,
          borderBottomRightRadius: 4 * scale,
          borderTopLeftRadius: 1 * scale,
          borderTopRightRadius: 1 * scale,
          backgroundColor: "#c7c7cc",
          alignItems: "center",
        }}
      >
        <View
          style={{
            width: 14 * scale,
            height: 2 * scale,
            borderBottomLeftRadius: 2 * scale,
            borderBottomRightRadius: 2 * scale,
            backgroundColor: "#a1a1a6",
          }}
        />
      </View>
    </View>
  );
}
