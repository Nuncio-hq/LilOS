/* The DM slice's stack routes (#156). App.tsx composes its `Routes` type from
   these so screens stay typed without importing the root navigator. */

export type DmRoutes = {
  Dm: { employeeId: string };
  Thread: { conversationId: string };
  FolderPicker: { employeeId: string };
  ModelPicker: { employeeId: string };
};
