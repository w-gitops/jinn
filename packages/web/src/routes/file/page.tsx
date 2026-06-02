import { useSearchParams } from "react-router-dom";
import { FileView } from "@/components/chat/file-view";

export default function FilePage() {
  const [sp] = useSearchParams();
  const path = sp.get("path") ?? "";
  return <FileView path={path} />;
}
