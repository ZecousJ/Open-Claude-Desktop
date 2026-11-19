const uuid="[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const base=`/api/organizations/${uuid}/chat_conversations/${uuid}`;
export const officialSideQuestionPath=new RegExp(`^${base}/side_question$`);
export const officialSideQuestionBatchPath=new RegExp(`^${base}/claudex_side_question/(${uuid})$`);
export const officialSideQuestionStopPath=new RegExp(`^${base}/claudex_side_question/(${uuid})/stop$`);
export function officialSideQuestionAction(method:string,path:string) {
  return method === "POST" && (officialSideQuestionPath.test(path) || officialSideQuestionStopPath.test(path));
}
export function officialSideQuestionRead(method:string,path:string,search:string) {
  return method === "GET" && officialSideQuestionBatchPath.test(path) && /^\?cursor=(0|[1-9][0-9]{0,6})$/.test(search);
}
