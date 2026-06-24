export interface StreamedBlockForPersistence {
  content: string;
  toolCall?: string;
}

export function shouldPreserveStreamedBlocks(args: {
  quietPreempted: boolean;
  streamedBlocks: StreamedBlockForPersistence[];
}): boolean {
  if (args.quietPreempted) return false;
  return args.streamedBlocks.some((m) => !!m.toolCall);
}

export function resultAlreadyInStreamedBlocks(
  result: string | null | undefined,
  streamedBlocks: StreamedBlockForPersistence[],
): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const resultKey = result ? normalize(result) : "";
  if (!resultKey) return false;
  const textBlocks = streamedBlocks
    .filter((m) => !m.toolCall)
    .map((m) => normalize(m.content))
    .filter(Boolean);
  if (textBlocks.at(-1) === resultKey) return true;
  return normalize(textBlocks.join("\n\n")) === resultKey;
}
