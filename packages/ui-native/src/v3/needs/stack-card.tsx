import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, PanResponder, Text, View } from "react-native";
import type { AskVM } from "../types";
import { AskCard } from "./ask-card";
import {
  DECIDE_DISTANCE_RATIO,
  flyTarget,
  type SwipeDecision,
  shouldClaimSwipe,
  swipeDecision,
} from "./swipe";

/* One card of the stack: the card at depth 0 is the one you decide; the next
   two peek out behind it, scaled down and lower. Only an approval ask swipes
   (right approves, left denies); questions and plans are answered with their
   buttons. The buttons run the same exit animation as a swipe, so a decision
   looks the same either way.

   Nothing here waits on a layout event to be visible: the front card is laid
   out in normal flow (so the deck is as tall as it is), the cards behind
   stretch over it and scale about their bottom edge, which needs no height.
   The measured width only feeds the swipe thresholds. */

/** How far each card behind sticks out below the one in front. */
export const PEEK = 12;
const SCALE_STEP = 0.05;
const EXIT_MS = 220;
const ANSWER_MS = 160;

const HIDDEN_FROM_READERS = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

export function StackCard({
  ask,
  depth,
  count,
  width,
  minHeight,
  onMeasureFront,
  onApprove,
  onDeny,
  onAnswer,
  onOpenThread,
}: {
  ask: AskVM;
  /** 0 = the card in front, 1 = the one right behind it … */
  depth: number;
  /** How many cards are in the stack; the front one stacks highest. */
  count: number;
  /** The card's width, the yardstick for the swipe threshold. */
  width: number;
  /** The tallest front card so far, so the deck keeps its height as cards
      change; 0 until one is measured, which only means "no minimum". */
  minHeight: number;
  /** The front card's laid-out height. */
  onMeasureFront: (height: number) => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAnswer: (id: string, option: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const swipeable = ask.kind === "approval";
  const front = depth === 0;

  const x = useRef(new Animated.Value(0)).current;
  const exitY = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const depthV = useRef(new Animated.Value(depth)).current;
  const leaving = useRef(false);

  // The handlers the PanResponder (created once) must see fresh.
  const live = useRef({ ask, front, swipeable, width });
  live.current = { ask, front, swipeable, width };
  const callbacks = useRef({ onApprove, onDeny, onAnswer });
  callbacks.current = { onApprove, onDeny, onAnswer };

  useEffect(() => {
    const move = Animated.spring(depthV, {
      toValue: depth,
      useNativeDriver: true,
      speed: 14,
      bounciness: 4,
    });
    move.start();
    return () => move.stop();
  }, [depth, depthV]);

  const decide = (d: Exclude<SwipeDecision, "none">) => {
    if (leaving.current) return;
    leaving.current = true;
    Animated.timing(x, {
      toValue: flyTarget(d, live.current.width),
      duration: EXIT_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      if (d === "approve") callbacks.current.onApprove(live.current.ask.id);
      else callbacks.current.onDeny(live.current.ask.id);
    });
  };

  const answer = (option: string) => {
    if (leaving.current) return;
    leaving.current = true;
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 0,
        duration: ANSWER_MS,
        useNativeDriver: true,
      }),
      Animated.timing(exitY, {
        toValue: -24,
        duration: ANSWER_MS,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) callbacks.current.onAnswer(live.current.ask.id, option);
    });
  };

  const decideRef = useRef(decide);
  decideRef.current = decide;

  const responder = useMemo(() => {
    const springBack = () =>
      Animated.spring(x, {
        toValue: 0,
        useNativeDriver: true,
        speed: 18,
        bounciness: 8,
      }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        live.current.front &&
        live.current.swipeable &&
        !leaving.current &&
        shouldClaimSwipe(g.dx, g.dy),
      // Once the card owns the drag the page's ScrollView must not take it.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => x.setValue(g.dx),
      onPanResponderRelease: (_, g) => {
        const d = swipeDecision(g.dx, g.vx, live.current.width);
        if (d === "none") springBack();
        else decideRef.current(d);
      },
      onPanResponderTerminate: springBack,
    });
  }, [x]);

  // The cards behind shrink toward their bottom edge (which stays where the
  // front card's bottom is) and sit a peek lower each; the height never enters.
  const { scale, lift, opacity } = useMemo(() => {
    const at = (i: number) => 1 - SCALE_STEP * Math.min(i, 2);
    const down = (i: number) => Math.min(i, 2) * PEEK;
    const inputRange = [0, 1, 2, 3];
    return {
      scale: depthV.interpolate({
        inputRange,
        outputRange: [at(0), at(1), at(2), at(3)],
        extrapolate: "clamp",
      }),
      lift: depthV.interpolate({
        inputRange,
        outputRange: [down(0), down(1), down(2), down(3)],
        extrapolate: "clamp",
      }),
      // Beyond the third card nothing shows.
      opacity: depthV.interpolate({
        inputRange,
        outputRange: [1, 1, 1, 0],
        extrapolate: "clamp",
      }),
    };
  }, [depthV]);

  const tilt = x.interpolate({
    inputRange: [-width, 0, width],
    outputRange: ["-9deg", "0deg", "9deg"],
  });
  const approveStamp = x.interpolate({
    inputRange: [0, width * DECIDE_DISTANCE_RATIO],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  const denyStamp = x.interpolate({
    inputRange: [-width * DECIDE_DISTANCE_RATIO, 0],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  return (
    <Animated.View
      testID={front ? "ask-card" : undefined}
      accessibilityLabel={front ? `Ask: ${ask.title}` : undefined}
      {...(front ? null : HIDDEN_FROM_READERS)}
      pointerEvents={front ? "auto" : "none"}
      onLayout={
        front ? (e) => onMeasureFront(e.nativeEvent.layout.height) : undefined
      }
      className="rounded-[22px] border border-rule bg-paper-soft"
      style={{
        marginHorizontal: 20,
        ...(front
          ? { minHeight }
          : {
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: PEEK * 2,
            }),
        transformOrigin: "center bottom",
        zIndex: count - depth,
        opacity: Animated.multiply(opacity, fade),
        transform: [
          { translateX: x },
          { translateY: Animated.add(lift, exitY) },
          { rotate: tilt },
          { scale },
        ],
      }}
      {...(swipeable && front ? responder.panHandlers : null)}
    >
      <AskCard
        ask={ask}
        onApprove={() => decide("approve")}
        onDeny={() => decide("deny")}
        onAnswer={answer}
        onOpenThread={
          ask.threadId ? () => onOpenThread(ask.threadId as string) : undefined
        }
      />
      {swipeable && front ? (
        <View
          pointerEvents="none"
          {...HIDDEN_FROM_READERS}
          className="absolute inset-x-0 top-0 flex-row justify-between px-5 pt-5"
        >
          <Stamp label="Approve" opacity={approveStamp} tilt="-10deg" />
          <Stamp label="Deny" opacity={denyStamp} tilt="10deg" />
        </View>
      ) : null}
    </Animated.View>
  );
}

/** The word that fades in as you drag: ink, outlined, a little crooked, like
    a rubber stamp. Never a colour: approve and deny are not statuses. */
function Stamp({
  label,
  opacity,
  tilt,
}: {
  label: string;
  opacity: Animated.AnimatedInterpolation<number>;
  tilt: string;
}) {
  return (
    <Animated.View
      className="rounded-lg border-2 border-ink bg-paper-soft px-3 py-1"
      style={{ opacity, transform: [{ rotate: tilt }] }}
    >
      <Text className="font-bold text-[20px] text-ink uppercase tracking-widest">
        {label}
      </Text>
    </Animated.View>
  );
}
