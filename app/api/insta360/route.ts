/**
 * アプリ本体のCloudflare Workerが提供する共有URL解決エンドポイント。
 * 実装はGitHub Pages用の専用Workerと共有している。
 */
import { handleInsta360Options, handleInsta360Request } from "../../insta360-resolver";

export function OPTIONS() {
  return handleInsta360Options();
}

export function GET(request: Request) {
  return handleInsta360Request(request);
}
