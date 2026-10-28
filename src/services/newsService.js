import { requestNews } from "./bridge.js";

export async function getNews() {
  const data = await requestNews();
  if (!data?.items) throw new Error("News payload is empty");
  return data;
}

