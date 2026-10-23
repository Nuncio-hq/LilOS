import * as Haptics from "expo-haptics";

/* The three taps the v3 screens use; one place so they feel the same. */

export const hapticApprove = () =>
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
export const hapticDeny = () =>
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
export const hapticSelect = () => void Haptics.selectionAsync();
