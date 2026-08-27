/**
 * アプリ本体のCloudflare Workerが提供するSuperSplatシーンURL解決エンドポイント。
 * 実装はGitHub Pages用の専用Workerと共有している。
 */
import { handleSuperSplatOptions, handleSuperSplatRequest } from "../../supersplat-resolver";

export function OPTIONS() {
  return handleSuperSplatOptions();
}

export function GET(request: Request) {
  return handleSuperSplatRequest(request);
}
