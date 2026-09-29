import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, Pressable, type PressableProps } from "react-native";

/* Motion shared by the conversation (web: .lilos-rise / press-in). Things
   arrive: they rise a few points and fade in with a soft spring-like ease.
   Cards press in a little under the finger. */

export function Rise({
  children,
  delay = 0,
}: {
  children: ReactNode;
  /** Stagger siblings, in ms. */
  delay?: number;
}) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: 1,
      duration: 420,
      delay,
      easing: Easing.bezier(0.2, 0.9, 0.25, 1.1),
      useNativeDriver: true,
    }).start();
  }, [v, delay]);
  return (
    <Animated.View
      style={{
        opacity: v,
        transform: [
          {
            translateY: v.interpolate({
              inputRange: [0, 1],
              outputRange: [10, 0],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/** A Pressable that scales down a touch while held. */
export function PressCard({ style, children, ...props }: PressableProps) {
  const s = useRef(new Animated.Value(1)).current;
  const to = (x: number) =>
    Animated.spring(s, {
      toValue: x,
      speed: 40,
      bounciness: 6,
      useNativeDriver: true,
    }).start();
  return (
    <Animated.View style={{ transform: [{ scale: s }] }}>
      <Pressable
        {...props}
        style={style}
        onPressIn={(e) => {
          to(0.97);
          props.onPressIn?.(e);
        }}
        onPressOut={(e) => {
          to(1);
          props.onPressOut?.(e);
        }}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}
