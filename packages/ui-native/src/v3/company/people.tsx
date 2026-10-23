import { Pressable, View } from "react-native";
import { Avatar, CeoChip, SectionBlock, StatusLabel, T } from "../kit";
import { ListRow } from "../rows";
import type { OrgNodeVM, PersonRowVM } from "./types";

/* People (who works here, and how they are doing) and Org (who reports to
   whom). Org leaves status out: People already says it. */

export function PeopleSection({
  people,
  onOpenAgent,
  onHire,
}: {
  people: PersonRowVM[];
  onOpenAgent: (id: string) => void;
  onHire: () => void;
}) {
  return (
    <SectionBlock title="People" action="Hire" onAction={onHire}>
      {people.map((p, i) => (
        <ListRow
          key={p.person.id}
          testID={`person-${p.person.id}`}
          label={p.person.name}
          onPress={() => onOpenAgent(p.person.id)}
          last={i === people.length - 1}
        >
          <View className="flex-row items-center gap-3">
            <Avatar person={p.person} size={40} />
            <View className="flex-1 gap-0.5">
              <View className="flex-row items-center gap-1.5">
                <T variant="label" numberOfLines={1} className="shrink">
                  {p.person.name}
                </T>
                {p.person.isCeo ? <CeoChip /> : null}
              </View>
              <T variant="caption" tone="ink2" numberOfLines={1}>
                {p.roleLine}
              </T>
            </View>
            <StatusLabel status={p.status} label={p.statusWord} />
          </View>
        </ListRow>
      ))}
    </SectionBlock>
  );
}

const ORG_ROW = 44;
const AVATAR = 26;
/* The vertical line runs under the parent's avatar centre. */
const TRUNK = AVATAR / 2;
const BRANCH = 14;

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
  const { person } = node;
  return (
    <View style={connector ? { paddingLeft: TRUNK + BRANCH + 4 } : undefined}>
      {connector ? (
        <>
          <View
            className="absolute bg-rule"
            style={{
              left: 0,
              top: 0,
              width: 1,
              ...(connector.last ? { height: ORG_ROW / 2 } : { bottom: 0 }),
            }}
          />
          <View
            className="absolute bg-rule"
            style={{ left: 0, top: ORG_ROW / 2, height: 1, width: BRANCH }}
          />
        </>
      ) : null}
      <Pressable
        testID={`org-${person.id}`}
        accessibilityRole="button"
        accessibilityLabel={`Org: ${person.name}`}
        onPress={() => onOpenAgent(person.id)}
        className="flex-row items-center gap-2.5 active:opacity-60"
        style={{ height: ORG_ROW }}
      >
        <Avatar person={person} size={AVATAR} />
        <T variant="small" className="shrink font-semibold" numberOfLines={1}>
          {person.name}
        </T>
        {person.isCeo ? <CeoChip /> : null}
        <T
          variant="caption"
          tone="ink3"
          numberOfLines={1}
          className="min-w-0 flex-1"
        >
          {person.role}
        </T>
      </Pressable>
      {node.reports.length ? (
        <View style={{ marginLeft: TRUNK }}>
          {node.reports.map((r, i) => (
            <OrgNode
              key={r.person.id}
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

export function OrgSection({
  org,
  onOpenAgent,
}: {
  org: OrgNodeVM[];
  onOpenAgent: (id: string) => void;
}) {
  return (
    <SectionBlock title="Org">
      <View className="px-5 pt-1">
        {org.map((n) => (
          <OrgNode key={n.person.id} node={n} onOpenAgent={onOpenAgent} />
        ))}
      </View>
    </SectionBlock>
  );
}
