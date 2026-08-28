export function findTmuxSessionId(output, sessionName) {
  for (const row of String(output || "").split("\n")) {
    const [id, ...nameParts] = row.split("\t");
    if (/^\$\d+$/.test(id) && nameParts.join("\t") === sessionName) return id;
  }
  return null;
}
