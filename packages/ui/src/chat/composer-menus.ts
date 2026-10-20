import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { FileMention, SlashItem } from "../types";
import { composerKeyDown } from "./composer-keys";
import {
  insertMention,
  mentionBeforeCaret,
  mentionQuery,
} from "./composer-mentions";
import { insertSlash, slashQuery } from "./composer-slash";

/* What a message box does besides typing, said once for every composer (the
   chat composer and the v3 one): the `@` menu (people, then files of the
   session folder), the `/` menu (the engine's commands), arrows/Enter/Tab on
   an open menu, an atomic `@token` under Backspace, ↑ to recall the last
   message, and where the caret lands after a pick. Each composer draws the
   menus its own way from the state returned here. */

export type MentionRow<E> =
  | { kind: "emp"; employee: E }
  | { kind: "file"; file: FileMention };

/** What a composer draws its menus from. */
export interface ComposerMenus<E> {
  /** Put on the composer's root: the caret/focus effect looks inside it. */
  wrapRef: RefObject<HTMLDivElement | null>;
  /** The textarea's keydown; `keys` carries what ⌘. and ↑ act on. */
  onKeyDown: (
    e: KeyboardEvent<HTMLTextAreaElement>,
    keys?: { running?: boolean; onStop?: () => void; lastSent?: string },
  ) => void;
  /** Call on every edit: typing reopens a menu Esc closed. */
  onEdited: () => void;
  slash: {
    open: boolean;
    /** `null` while the commands are being fetched. */
    hits: SlashItem[] | null;
    rows: SlashItem[];
    active: number;
    pick: (item: SlashItem) => void;
  };
  mention: {
    open: boolean;
    employees: E[];
    /** `null` while the files are being fetched. */
    fileHits: FileMention[] | null;
    active: number;
    pick: (row: MentionRow<E>) => void;
    /** Whether the Files section applies (a folder to search). */
    files: boolean;
  };
}

export function useComposerMenus<E extends { id: string; name: string }>({
  draft,
  setDraft,
  employees,
  onSearchFiles,
  onSearchCommands,
}: {
  draft: string;
  setDraft: (v: string) => void;
  /** Who the `@` menu lists first. Empty + no file search = no `@` menu. */
  employees: E[];
  /** Files of the session's folder matching the text after `@`. Absent → no
      Files section (no folder context, no control). */
  onSearchFiles?: (query: string) => Promise<FileMention[]>;
  /** The engine's commands matching the text after the leading `/`. Absent →
      `/` stays plain text. */
  onSearchCommands?: (query: string) => Promise<SlashItem[]>;
}): ComposerMenus<E> {
  /* Esc closes a menu once; the next keystroke reopens it (a menu is derived
     from the draft, so dismissal lives in a flag). */
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* File rows for the Files section: the host fuzzy-matches per keystroke;
     `null` = a search is in flight, `[]` = no hits. */
  const fragment = mentionQuery(draft);
  const fragmentQuery = fragment?.query ?? null;
  const [fileHits, setFileHits] = useState<FileMention[] | null>(null);
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!onSearchFiles || fragmentQuery === null) {
      setFileHits(null);
      return;
    }
    const seq = ++searchSeq.current;
    let live = true;
    void onSearchFiles(fragmentQuery).then(
      (hits) => {
        if (live && seq === searchSeq.current) setFileHits(hits);
      },
      () => {
        if (live && seq === searchSeq.current) setFileHits([]);
      },
    );
    return () => {
      live = false;
    };
  }, [onSearchFiles, fragmentQuery]);

  /* The `/` menu's rows — same fetch-per-keystroke shape as the file hits.
     `null` = a search is in flight or the menu never applied. */
  const slashQ = slashQuery(draft);
  const [slashHits, setSlashHits] = useState<SlashItem[] | null>(null);
  const slashSeq = useRef(0);
  useEffect(() => {
    if (!onSearchCommands || slashQ === null) {
      setSlashHits(null);
      return;
    }
    const seq = ++slashSeq.current;
    let live = true;
    void onSearchCommands(slashQ).then(
      (hits) => {
        if (live && seq === slashSeq.current) setSlashHits(hits);
      },
      () => {
        if (live && seq === slashSeq.current) setSlashHits([]);
      },
    );
    return () => {
      live = false;
    };
  }, [onSearchCommands, slashQ]);

  /* Flat keyboard navigation (issue #105, AC-1): one active index over
     [employees…, files…]; ↓/↑ move, Enter picks. The reset runs during
     render, not in an effect: it must commit atomically with the rows it
     belongs to — a passive effect flushes a task late, and a ↓ landing in
     that window got clobbered back to the top row (#693). */
  const [slashActive, setSlashActive] = useState(0);
  const [slashNav, setSlashNav] = useState<{
    query: string | null;
    hits: SlashItem[] | null;
  }>({ query: slashQ, hits: slashHits });
  if (slashNav.query !== slashQ || slashNav.hits !== slashHits) {
    setSlashNav({ query: slashQ, hits: slashHits });
    setSlashActive(0);
  }
  const [active, setActive] = useState(0);
  const [navRows, setNavRows] = useState<{
    query: string | null;
    hits: FileMention[] | null;
  }>({ query: fragmentQuery, hits: fileHits });
  if (navRows.query !== fragmentQuery || navRows.hits !== fileHits) {
    setNavRows({ query: fragmentQuery, hits: fileHits });
    setActive(0);
  }

  const slashOpen = !slashDismissed && slashQ !== null && !!onSearchCommands;
  const slashRows = slashHits ?? [];
  const rows: MentionRow<E>[] = [
    ...employees.map((employee) => ({ kind: "emp" as const, employee })),
    ...(fileHits ?? []).map((file) => ({ kind: "file" as const, file })),
  ];
  const mentionOpen =
    !mentionDismissed &&
    fragment !== null &&
    (employees.length > 0 || !!onSearchFiles);

  /* Caret moves a pick/delete wants, applied in the layout effect right after
     the draft commits — an rAF can fire after the next keystroke and yank the
     caret backwards mid-typing (e2e caught `@src/app.tsx ap@`). */
  const caretRef = useRef<number | null>(null);
  const prevDraftRef = useRef(draft);
  useLayoutEffect(() => {
    /* #590 AC-1: an external prefill (draft goes empty → text — plan
       "Change…", a seeded rewind) focuses the composer and lands the caret
       at the end, after any prefix, so the user types the answer straight
       away. Pick/deletes take precedence via caretRef. */
    const at =
      caretRef.current ??
      (prevDraftRef.current === "" && draft !== "" ? draft.length : null);
    caretRef.current = null;
    prevDraftRef.current = draft;
    if (at === null) return;
    const el = wrapRef.current?.querySelector("textarea");
    el?.focus();
    el?.setSelectionRange(at, at);
  });

  const pickSlash = (item: SlashItem) => {
    const next = insertSlash(item.name);
    caretRef.current = next.length;
    setDraft(next);
  };
  const pickMention = (row: MentionRow<E>) => {
    const next =
      row.kind === "emp"
        ? insertMention(draft, row.employee.name, false)
        : insertMention(draft, row.file.path, row.file.kind === "dir");
    caretRef.current = next.length;
    setDraft(next);
  };

  /** Typing reopens a menu Esc closed. */
  const onEdited = () => {
    setMentionDismissed(false);
    setSlashDismissed(false);
  };

  /** The textarea's keydown: an open menu owns the arrows, Enter and Tab; a
      Backspace right after an `@token` removes the whole mention; the rest
      (Esc closes a menu, ⌘. stops, ↑ recalls) is `composerKeyDown`. */
  const onKeyDown = (
    e: KeyboardEvent<HTMLTextAreaElement>,
    keys: { running?: boolean; onStop?: () => void; lastSent?: string } = {},
  ) => {
    const menuKey =
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Enter" ||
      e.key === "Tab";
    if (slashOpen && menuKey) {
      /* "No matches" doesn't own Enter/Tab — the full `/cmd` draft still
         submits so the engine (or an app-owned command) sees it. */
      if (
        slashRows.length === 0 &&
        e.key !== "ArrowDown" &&
        e.key !== "ArrowUp"
      )
        return;
      e.preventDefault();
      if (slashRows.length === 0) return;
      if (e.key === "ArrowDown") {
        setSlashActive((a) => (a + 1) % slashRows.length);
      } else if (e.key === "ArrowUp") {
        setSlashActive((a) => (a - 1 + slashRows.length) % slashRows.length);
      } else {
        pickSlash(slashRows[Math.min(slashActive, slashRows.length - 1)]);
      }
      return;
    }
    if (mentionOpen && menuKey) {
      /* The open menu owns these keys (AC-1): ↑/↓ move the flat highlight,
         Enter/Tab insert the highlighted row. */
      e.preventDefault();
      if (rows.length === 0) return;
      if (e.key === "ArrowDown") {
        setActive((a) => (a + 1) % rows.length);
      } else if (e.key === "ArrowUp") {
        setActive((a) => (a - 1 + rows.length) % rows.length);
      } else {
        pickMention(rows[Math.min(active, rows.length - 1)]);
      }
      return;
    }
    /* Atomic chips (#105, AC-3): Backspace right after an `@token` removes
       the whole mention, not one character. */
    if (e.key === "Backspace" && !e.defaultPrevented) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const at = mentionBeforeCaret(el.value, el.selectionStart);
        if (at !== null) {
          e.preventDefault();
          caretRef.current = at;
          setDraft(el.value.slice(0, at) + el.value.slice(el.selectionStart));
          return;
        }
      }
    }
    composerKeyDown({
      running: keys.running ?? false,
      onStop: keys.onStop,
      lastSent: keys.lastSent,
      setDraft,
      onDismissOverlay: slashOpen
        ? () => setSlashDismissed(true)
        : mentionOpen
          ? () => setMentionDismissed(true)
          : undefined,
    })(e);
  };

  return {
    wrapRef,
    onKeyDown,
    onEdited,
    slash: {
      open: slashOpen,
      hits: slashHits,
      rows: slashRows,
      active: slashActive,
      pick: pickSlash,
    },
    mention: {
      open: mentionOpen,
      employees,
      fileHits,
      active,
      pick: pickMention,
      files: !!onSearchFiles,
    },
  };
}
