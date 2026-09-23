export function ensurePendingInteractions(session) {
  if (!Array.isArray(session.pendingInteractions)) {
    session.pendingInteractions = session.pendingApproval ? [session.pendingApproval] : [];
  }
  return session.pendingInteractions;
}

export function syncPendingInteraction(session) {
  const interactions = ensurePendingInteractions(session);
  const actionable = interactions
    .filter((interaction) => interaction?.id && interaction.canRespond)
    .sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")));
  session.pendingApproval = actionable[0] || interactions[0] || null;
  session.control.canApprove = Boolean(session.pendingApproval?.kind === "permission" && session.pendingApproval.canRespond);
  session.control.canAnswer = Boolean(session.pendingApproval?.kind === "question" && session.pendingApproval.canRespond);
  if (session.pendingApproval?.canRespond) {
    session.status = "waiting";
    session.statusReason = session.pendingApproval.reason;
    session.control.mode = session.pendingApproval.kind === "question" ? "answer" : "approve";
  }
}

function interactionEventId(event) {
  return event.approvalId
    || event.approval?.id
    || event.interactionId
    || event.interaction?.id
    || null;
}

function sameInteraction(interaction, event) {
  const id = interactionEventId(event);
  if (event.turnId && interaction.turnId && event.turnId !== interaction.turnId) return false;
  return Boolean(id && interaction.id === id);
}

export function replaceOrAddInteraction(session, interaction) {
  const interactions = ensurePendingInteractions(session);
  const index = interactions.findIndex((candidate) => candidate.id === interaction.id);
  if (index >= 0) interactions[index] = interaction;
  else interactions.push(interaction);
  syncPendingInteraction(session);
}

export function removeInteraction(session, event, { unavailable = false } = {}) {
  const interactions = ensurePendingInteractions(session);
  const matching = interactions.filter((interaction) => sameInteraction(interaction, event));
  // An unlabelled terminal/interaction event is safe only when there is one
  // candidate for that turn. Never let an old event clear a different request.
  if (!interactionEventId(event) && matching.length !== 1) return false;
  if (unavailable) {
    for (const interaction of matching) {
      interaction.canRespond = false;
      interaction.delivery = event.delivery || "not_delivered";
      interaction.unavailableReason = event.reason || null;
    }
  } else {
    session.pendingInteractions = interactions.filter((interaction) => !matching.includes(interaction));
  }
  syncPendingInteraction(session);
  return matching.length > 0;
}
