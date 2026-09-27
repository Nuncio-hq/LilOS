import { type ReactNode, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { Screen } from "../components/screen";
import {
  CODE_LENGTH,
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
}: {
  onSubmit: (offer: PairingOffer) => void;
}) {
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<ManualErrors>({});
  const codeRef = useRef<TextInput>(null);

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
            placeholder="ABC-123"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={CODE_LENGTH + 1}
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
