/// The two PushCloud calls this package makes, in one place so the hook and
/// `setup` cannot drift into asking the question two different ways.

export async function api(origin, path, credential, init) {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}`);
  return res.json();
}

/// The three answers every PushCloud question offers.
///
/// The reply action is not decoration: the respond route rejects a typed answer
/// outright unless the question carries one, so without it "no, do X instead"
/// is not an answer anyone can give.
export const APPROVAL_ACTIONS = [
  { id: "allow", label: "Approve", type: "button" },
  { id: "deny", label: "Deny", type: "button" },
  { id: "reason", label: "Deny with a reason", type: "reply" },
];

export async function askQuestion(cfg, { title, message }) {
  const sent = await api(cfg.api, "/v1/messages", cfg.token, {
    method: "POST",
    body: JSON.stringify({
      title,
      message,
      // Time-sensitive: someone is sitting in a blocked terminal waiting on
      // this, so it should break through a focus mode.
      priority: 1,
      // The question outlives the caller deliberately. If the wait times out and
      // the answer arrives a minute later, it still lands somewhere real.
      expires_in: 3600,
      actions: APPROVAL_ACTIONS,
    }),
  });
  if (!sent.interaction_id) throw new Error("the message carried no question");
  return sent.interaction_id;
}

/// Blocks on the server until the question is answered or `seconds` runs out.
/// Returns the parsed answer, or null if nobody answered in time.
export async function waitForAnswer(cfg, interactionId, seconds) {
  const { interaction } = await api(
    cfg.api,
    `/v1/interactions/${interactionId}/wait?timeout=${seconds}`,
    cfg.key
  );
  if (interaction.status !== "responded") return null;
  return JSON.parse(interaction.response ?? "{}");
}

export async function sendNote(cfg, { title, message }) {
  return api(cfg.api, "/v1/messages", cfg.token, {
    method: "POST",
    body: JSON.stringify({ title, message, priority: 0 }),
  });
}
