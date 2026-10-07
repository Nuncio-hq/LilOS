import { type ReactNode, useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { Screen } from "../components/screen";
import {
  CODE_FORMATTED_LENGTH,
  formatCode,
  type ManualErrors,
  normalizeCode,
  normalizeHost,
  type PairingOffer,
  validateManual,
} from "../lib/pairing-code";

/* Step 3b — type what the Mac shows under its QR: the address and the code. */
export function ManualCodeScreen({
  onSubmit,
  reenter,
}: {
  onSubmit: (offer: PairingOffer) => void;
  /** #688 AC-1: back from a wrong typed code — the field is focused with
     its whole entry selected so the first keystroke replaces it (screen
     state survives the popTo, so the previous entry is already there). */
  reenter?: boolean;
}) {
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<ManualErrors>({});
  const codeRef = useRef<TextInput>(null);

  /* `autoFocus` only applies on mount — this screen stays mounted under
     Connecting, so reentry focuses programmatically and selects the
     whole kept entry (AC-1: first keystroke replaces it). Selection is
     set imperatively: iOS doesn't apply selectTextOnFocus or a
     controlled `selection` prop for a programmatic .focus(). */
  useEffect(() => {
    if (!reenter) return;
    const t = setTimeout(() => {
      const input = codeRef.current;
      input?.focus();
      input?.setSelection?.(0, CODE_FORMATTED_LENGTH);
    }, 100);
    return () => clearTimeout(t);
  }, [reenter]);

  const submit = () => {
    const e = validateManual(host, code);
    setErrors(e);
    if (e.host || e.code) return;
    onSubmit({ host: normalizeHost(host), code: normalizeCode(code) });
  };

  const field = (bad?: string) =>
    `h-[52px] rounded-2xl border bg-secondary px-4 text-foreground ${bad ? "border-destructive" : "border-transparent"}`;

  return (
    <Screen
      topInset={false}
      footer={<Button label="Connect" onPress={submit} />}
    >
      <View className="gap-7 pt-2">
        <View className="gap-2">
          <AppText size="title">Enter the code</AppText>
          <AppText tone="muted">
            On your Mac, the address and code are under the QR in Pair phone.
          </AppText>
        </View>
        <Field label="Mac address" error={errors.host}>
          <TextInput
            value={host}
            onChangeText={(t) => {
              setHost(t);
              if (errors.host) setErrors({ ...errors, host: undefined });
            }}
            placeholder="your-mac.your-tailnet.ts.net"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="next"
            onSubmitEditing={() => codeRef.current?.focus()}
            className={`${field(errors.host)} text-base`}
            placeholderTextColorClassName="accent-muted-foreground"
          />
        </Field>
        <Field label="Pairing code" error={errors.code}>
          <TextInput
            ref={codeRef}
            value={formatCode(code)}
            onChangeText={(t) => {
              setCode(normalizeCode(t));
              if (errors.code) setErrors({ ...errors, code: undefined });
            }}
            placeholder="XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoCorrect={false}
            /* The value is the formatted code — the cap counts its dashes
               (#593 AC-1). normalizeCode still slices to 12 real chars. */
            maxLength={CODE_FORMATTED_LENGTH}
            returnKeyType="go"
            onSubmitEditing={submit}
            className={`${field(errors.code)} font-mono text-xl tracking-[2px]`}
            placeholderTextColorClassName="accent-muted-foreground"
          />
        </Field>
      </View>
    </Screen>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <AppText size="sm" weight="medium" tone="muted">
        {label}
      </AppText>
      {children}
      {error && (
        <AppText size="sm" tone="destructive">
          {error}
        </AppText>
      )}
    </View>
  );
}
