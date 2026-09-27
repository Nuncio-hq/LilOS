import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { useMemo, useState } from "react";

/* Reasoning-effort control, "neural network" style: the filled part of the
   capsule is a small network of nodes and links; the further right, the
   brighter the links and the more signals travel along them. No per-level
   ticks (like Codex): you drag and it snaps to the model's levels; the level
   name above ("Reasoning · Medium") says where you are. The number of stops is
   the model's real ladder. Base UI keeps drag, keyboard and the aria value.
   The glide also runs while dragging: steps are discrete, and Base UI flags a
   plain click on the track as a drag, so a drag-only opt-out kills it. */

const THUMB = 22; // px — thumb diameter; the fill ends at its centre
const NODES = 26;
const SIGNALS = 8;

const KEYFRAMES = `
@keyframes lilos-nn-twinkle { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
@keyframes lilos-nn-glow { 0%, 100% { box-shadow: 0 0 8px 1px rgba(217,70,239,.35) } 50% { box-shadow: 0 0 18px 4px rgba(217,70,239,.7) } }
`;

/* Deterministic layout: the same network on every render and every session. */
function network() {
  let seed = 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const nodes = Array.from({ length: NODES }, () => ({
    x: 2 + rnd() * 96,
    y: 18 + rnd() * 64,
    r: 1.3 + rnd() * 1.2,
    delay: rnd() * 3,
  })).sort((a, b) => a.x - b.x);
  const links: [number, number][] = [];
  nodes.forEach((_, i) => {
    for (let j = i + 1; j < Math.min(nodes.length, i + 3); j++)
      links.push([i, j]);
  });
  const signals = Array.from({ length: SIGNALS }, () => ({
    link: links[Math.floor(rnd() * links.length)],
    dur: 0.9 + rnd() * 1.1,
  }));
  return { nodes, links, signals };
}

const pct = (n: number) => `${n}%`;

export function EffortSlider({
  efforts,
  index,
  label,
  onPick,
  onPreview,
}: {
  efforts: string[];
  index: number;
  label: (e: string) => string;
  onPick: (effort: string) => void;
  /* Live drag feedback (label/fill move with the thumb); `onPick` still
     fires only on commit. */
  onPreview?: (effort: string) => void;
}) {
  const { nodes, links, signals } = useMemo(network, []);
  const last = efforts.length - 1;
  /* Drag previews locally; `onPick` fires once on commit (release / arrow
     settle) — the pick is an RPC against the engine, not a per-step hop. */
  const [drag, setDrag] = useState<number | null>(null);
  const i = drag ?? Math.max(index, 0);
  const t = last ? i / last : 0;
  const max = i === last;
  /* Where the fill ends: the thumb's centre. */
  const edge = `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${t})`;
  const hue = 235 + 60 * t;
  return (
    <div>
      <style href="lilos-effort-nn" precedence="default">
        {KEYFRAMES}
      </style>
      <SliderPrimitive.Root
        aria-label="Reasoning effort"
        className="w-full"
        min={0}
        max={last}
        step={1}
        value={[i]}
        thumbAlignment="edge"
        onValueChange={(v) => {
          const n = Array.isArray(v) ? v[0] : v;
          if (efforts[n] !== undefined) {
            setDrag(n);
            onPreview?.(efforts[n]);
          }
        }}
        onValueCommitted={(v) => {
          const n = Array.isArray(v) ? v[0] : v;
          setDrag(null);
          if (efforts[n] && n !== index) onPick(efforts[n]);
        }}
      >
        <SliderPrimitive.Control className="relative flex h-7 w-full cursor-pointer touch-none select-none items-center">
          <SliderPrimitive.Track
            className="relative h-7 w-full rounded-full bg-muted shadow-inner motion-reduce:animate-none"
            style={
              max
                ? { animation: "lilos-nn-glow 1.6s ease-in-out infinite" }
                : undefined
            }
          >
            {/* The network spans the whole track and is revealed up to the
                thumb, so nodes stay put while the fill grows. */}
            <div
              data-slot="effort-fill"
              aria-hidden
              className="absolute inset-0 overflow-hidden rounded-full transition-[clip-path,background] duration-300 ease-out motion-reduce:transition-none"
              style={{
                clipPath: `inset(0 calc(100% - ${edge}) 0 0 round 999px)`,
                background: `linear-gradient(90deg, #172554, hsl(${hue} 70% ${30 + 18 * t}%) ${edge})`,
              }}
            >
              <svg className="absolute inset-0 size-full" aria-hidden>
                {links.map(([a, b]) => (
                  <line
                    key={`${a}-${b}`}
                    x1={pct(nodes[a].x)}
                    y1={pct(nodes[a].y)}
                    x2={pct(nodes[b].x)}
                    y2={pct(nodes[b].y)}
                    stroke="#c4b5fd"
                    strokeWidth={0.8}
                    strokeOpacity={0.18 + 0.55 * t}
                    className="transition-[stroke-opacity] duration-300"
                  />
                ))}
                {nodes.map((n) => (
                  <circle
                    key={`${n.x}-${n.y}`}
                    cx={pct(n.x)}
                    cy={pct(n.y)}
                    r={n.r}
                    fill="#fff"
                    className="motion-reduce:animate-none"
                    style={{
                      animation: `lilos-nn-twinkle 3s ease-in-out ${n.delay}s infinite`,
                    }}
                  />
                ))}
                {/* Signals along the links: more of them the higher the effort. */}
                {signals
                  .slice(0, Math.round(t * SIGNALS))
                  .map(({ link, dur }) => {
                    const [a, b] = link.map((k) => nodes[k]);
                    return (
                      <circle
                        key={`${a.x}-${b.x}-${dur}`}
                        data-signal
                        r={1.8}
                        fill="#f0abfc"
                        className="motion-reduce:hidden"
                      >
                        <animate
                          attributeName="cx"
                          from={pct(a.x)}
                          to={pct(b.x)}
                          dur={`${dur}s`}
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="cy"
                          from={pct(a.y)}
                          to={pct(b.y)}
                          dur={`${dur}s`}
                          repeatCount="indefinite"
                        />
                      </circle>
                    );
                  })}
              </svg>
            </div>
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-label="Reasoning effort"
            getAriaValueText={(_, v) => label(efforts[v] ?? "")}
            className="z-10 block rounded-full border border-black/5 bg-white shadow-md outline-none ring-violet-400/40 transition-[inset-inline-start,box-shadow] duration-300 ease-out hover:ring-3 focus-visible:ring-3 motion-reduce:transition-none"
            style={{ width: THUMB, height: THUMB }}
          />
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
      <div className="mt-1.5 flex justify-between px-1 text-[11px] text-muted-foreground">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
    </div>
  );
}
