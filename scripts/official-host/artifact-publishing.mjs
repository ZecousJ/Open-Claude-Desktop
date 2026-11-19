/** The original drawer uses the active account's hosted publication capability. */
export function publishingCapability(context){
 const account=context?.account,org=context?.activeOrganization,auth=account?.claudex_host_authentication,cap=account?.claudex_artifact_publishing;
 if(typeof account?.uuid==='string'&&account.uuid.length>0&&typeof org?.uuid==='string'&&org.uuid.length>0&&auth?.version===1&&auth.status==='authenticated'&&auth.account_uuid===account.uuid&&cap?.version===1&&cap.account_uuid===account.uuid&&cap.organization_uuid===org.uuid)return cap;
}
export function publishingUnavailable(context){
 return publishingCapability(context)?.supported===false;
}
export function blockedPublish(){}
export function PublicationPolicy({children}){
 return children;
}
export function PublishingUnavailableNotice({children}){
 return children;
}
