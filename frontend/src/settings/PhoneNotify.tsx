import { useEffect, useState } from "react";
import { useToast } from "../Toast";
import { API } from "../api";
import { Field, SS } from "./ui";

type PhoneCfg = {
  channel: "off" | "ntfy" | "email";
  ntfy_url: string; smtp_host: string; smtp_port: number; smtp_user: string;
  smtp_from: string; smtp_to: string; smtp_tls: boolean; smtp_pass_set?: boolean;
};

export function PhoneNotify() {
  const toast = useToast();
  const [cfg, setCfg] = useState<PhoneCfg | null>(null);
  const [pass, setPass] = useState(""); // write-only; blank keeps the stored one
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/phone-notify`).then((r) => r.json())
      .then((s) => setCfg({
        channel: s.channel ?? "off", ntfy_url: s.ntfy_url ?? "",
        smtp_host: s.smtp_host ?? "", smtp_port: s.smtp_port ?? 587, smtp_user: s.smtp_user ?? "",
        smtp_from: s.smtp_from ?? "", smtp_to: s.smtp_to ?? "", smtp_tls: s.smtp_tls ?? true,
        smtp_pass_set: !!s.smtp_pass_set,
      }))
      .catch(() => {});
  }, []);

  if (!cfg) return <p style={SS.credStatus}>Loading…</p>;
  const patch = (p: Partial<PhoneCfg>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const save = () => {
    setBusy(true);
    const body: Record<string, unknown> = { ...cfg };
    delete body.smtp_pass_set;
    if (pass.trim()) body.smtp_pass = pass.trim(); // omit when blank → server keeps stored
    fetch(`${API}/phone-notify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((s) => { patch({ smtp_pass_set: !!s.smtp_pass_set }); setPass(""); toast("Phone settings saved.", "success"); })
      .catch(() => toast("Couldn't save phone settings.", "error"))
      .finally(() => setBusy(false));
  };

  const test = () => {
    setBusy(true);
    fetch(`${API}/phone-notify/test`, { method: "POST" })
      .then((r) => r.json())
      .then((s) => toast(s.ok ? "Test sent — check your phone." : `Test failed: ${s.error}`, s.ok ? "success" : "error"))
      .catch(() => toast("Test failed — network error.", "error"))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <Field label="Channel">
        <select className="field" style={SS.input} value={cfg.channel} onChange={(e) => patch({ channel: e.target.value as PhoneCfg["channel"] })}>
          <option value="off">Off</option>
          <option value="ntfy">ntfy.sh (no account)</option>
          <option value="email">Email (SMTP)</option>
        </select>
      </Field>

      {cfg.channel === "ntfy" && (
        <>
          <Field label="Topic URL">
            <input className="field" style={SS.credInput} value={cfg.ntfy_url} placeholder="https://ntfy.sh/my-secret-topic"
              onChange={(e) => patch({ ntfy_url: e.target.value })} aria-label="ntfy topic URL" />
          </Field>
          <p style={SS.credStatus}>Install the ntfy app, subscribe to this exact topic. Anyone who knows the topic can read it — use a long random name.</p>
        </>
      )}

      {cfg.channel === "email" && (
        <>
          <Field label="SMTP host"><input className="field" style={SS.credInput} value={cfg.smtp_host} placeholder="smtp.gmail.com" onChange={(e) => patch({ smtp_host: e.target.value })} /></Field>
          <Field label="Port"><input className="field" style={SS.input} type="number" value={cfg.smtp_port} onChange={(e) => patch({ smtp_port: Number(e.target.value) || 587 })} /></Field>
          <Field label="Username"><input className="field" style={SS.credInput} value={cfg.smtp_user} placeholder="you@gmail.com" onChange={(e) => patch({ smtp_user: e.target.value })} /></Field>
          <Field label="Password / app password">
            <input className="field" style={SS.credInput} type="password" value={pass}
              placeholder={cfg.smtp_pass_set ? "•••••• (leave blank to keep)" : "app password"}
              onChange={(e) => setPass(e.target.value)} aria-label="SMTP password" />
          </Field>
          <Field label="From"><input className="field" style={SS.credInput} value={cfg.smtp_from} placeholder="you@gmail.com" onChange={(e) => patch({ smtp_from: e.target.value })} /></Field>
          <Field label="To (your phone)"><input className="field" style={SS.credInput} value={cfg.smtp_to} placeholder="you@icloud.com" onChange={(e) => patch({ smtp_to: e.target.value })} /></Field>
          <p style={SS.credStatus}>Use an app password (Gmail/iCloud require one), never your login password. Port 465 = SSL, 587 = STARTTLS.</p>
        </>
      )}

      {cfg.channel !== "off" && (
        <p style={SS.credStatus}>Which events reach your phone is set by the <b>Phone</b> column in the delivery
          table above. This section is just the connection.</p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Save</button>
        <button className="btn btn-secondary btn-sm" disabled={busy || cfg.channel === "off"} onClick={test}
          title="Send a test message to confirm it works">Send test</button>
      </div>
    </div>
  );
}
