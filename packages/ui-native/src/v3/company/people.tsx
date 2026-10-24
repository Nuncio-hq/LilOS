import { Pressable, Text, View } from "react-native";
import { AvatarRing, CeoChip, T } from "../kit";
import { INK } from "../status";
import type { OrgNodeVM } from "./types";

/* The org chart is the people list: everyone once, indented under whoever
   they report to, each with their status. */

/** The mark of an always-on bot reached through a connector, beside its name
    (the CEO chip's twin). */
function OutsideChip() {
  return (
    <View className="rounded border border-rule px-1.5 py-px">
      <Text className="font-semibold text-[10px] text-ink-2 uppercase tracking-wider">
        Outside
      </Text>
    </View>
  );
}

const AVATAR = 32;
/* The status ring adds this much round the avatar. */
const RING = 10;
const OUTER = AVATAR + RING;
const ROW = 52;
/* The vertical line runs under the parent's avatar centre. */
const TRUNK = OUTER / 2;
const BRANCH = 22;

function OrgNode({
  node,
  onOpenAgent,
  connector,
}: {
  node: OrgNodeVM;
  onOpenAgent: (id: string) => void;
  /** How this node hangs off its parent: absent for a root. */
  connector?: { last: boolean };
}) {
  const { person, status, statusWord, roleLine } = node.row;
  return (
    <View style={connector ? { paddingLeft: BRANCH + 4 } : undefined}>
      {connector ? (
        <>
          <View
            className="absolute bg-rule"
            style={{
              left: 0,
              top: 0,
              width: 1,
              ...(connector.last ? { height: ROW / 2 } : { bottom: 0 }),
            }}
          />
          <View
            className="absolute bg-rule"
            style={{ left: 0, top: ROW / 2, height: 1, width: BRANCH }}
          />
        </>
      ) : null}
      <Pressable
        testID={`org-${person.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${person.name}, ${roleLine}, ${statusWord}`}
        onPress={() => onOpenAgent(person.id)}
        className="flex-row items-center gap-2.5 active:opacity-60"
        style={{ height: ROW }}
      >
        <AvatarRing
          name={person.name}
          status={status}
          size={AVATAR}
          outside={person.outside}
        />
        <View className="shrink gap-px">
          <View className="flex-row items-center gap-1.5">
            <T
              variant="small"
              className="shrink font-semibold"
              numberOfLines={1}
            >
              {person.name}
            </T>
            {person.isCeo ? <CeoChip /> : null}
            {person.outside ? <OutsideChip /> : null}
          </View>
          <T variant="caption" tone="ink3" numberOfLines={1}>
            {person.role}
          </T>
        </View>
        <View className="flex-1" />
        <Text className={`font-semibold text-[12.5px] ${INK[status]}`}>
          {statusWord}
        </Text>
      </Pressable>
      {node.reports.length ? (
        <View style={{ marginLeft: TRUNK }}>
          {node.reports.map((r, i) => (
            <OrgNode
              key={r.row.person.id}
              node={r}
              onOpenAgent={onOpenAgent}
              connector={{ last: i === node.reports.length - 1 }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function OrgChart({
  org,
  onOpenAgent,
}: {
  org: OrgNodeVM[];
  onOpenAgent: (id: string) => void;
}) {
  return (
    <View>
      {org.map((n) => (
        <OrgNode key={n.row.person.id} node={n} onOpenAgent={onOpenAgent} />
      ))}
    </View>
  );
}
