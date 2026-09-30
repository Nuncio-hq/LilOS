import { useColorScheme } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Icon } from "./icon";
import { PROVIDER_LOGOS } from "./provider-logos";

/* Provider logos, the mobile twin of the web ModelLogo: the models.dev
   monochrome marks vendored in ./provider-logos, drawn as Paths with an
   explicit fill (a parsed SvgXml kept a black fill inside native form
   sheets). Any slug without a vendored mark gets the generic chip — never
   a broken image. */
export function ProviderLogo({
  slug,
  size = 16,
}: {
  /** models.dev slug, e.g. "anthropic". */
  slug?: string;
  size?: number;
}) {
  const color = useColorScheme() === "dark" ? "#ffffff" : "#000000";
  const logo = slug ? PROVIDER_LOGOS[slug] : undefined;
  if (!logo) return <Icon name="cpu" size={size - 2} tone="muted-foreground" />;
  const box = logo.box ?? 40;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`}>
      {logo.ds.map((d, i) => (
        <Path
          key={d.slice(0, 24)}
          d={d}
          fill={color}
          fillOpacity={logo.opacity?.[i] ?? 1}
          {...(logo.scale !== undefined
            ? { transform: `scale(${logo.scale})` }
            : {})}
        />
      ))}
    </Svg>
  );
}
