/** Connect saved Chat revisions, Markdown review and publishing availability to the original drawer. */
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export const hostStaticPreviewRevision='claudex-static-preview-v7';
export const hostStaticPreviewInputHashes={'c05b9cef3-ATrbYDa5.js':'b3d2850fd23717ac6f1db64048f7097739ac286d74dff6ce1ee3ff6b69ddbf06','cbaae0d6d-JY6h84ty.js':'415412e839787e9ea316c3d6bdeba3442741943a5f0d9d21c96347c37182e62a','c147e6f61-DfwDuN_w.js':'2beed1edf2608dcf064281dfb038dee20e69307b24455548e1e6939f83228a1d'};
export const hostStaticPreviewOriginalHashes={'c05b9cef3-ATrbYDa5.js':'b3d2850fd23717ac6f1db64048f7097739ac286d74dff6ce1ee3ff6b69ddbf06','cbaae0d6d-JY6h84ty.js':'76482e79482a6f3216df6fffafd445306bcf48250efdeb67b5cd9a889602a257','c147e6f61-DfwDuN_w.js':'10dea7adce2c63c0a219dc1c091240178fb21fb5d7c26421411987c49347715c'};
export const hostStaticPreviewRules=[];

/** Exact resolved drawer version, never the route hint or latest-version fallback. */
// Canonical emitted bytes: never serialize a function after a build tool rewrites it.
export const staticDrawerSelectionSource = "function __claudexDrawerSelection({organizationId,conversationId,versionId,rows,shared,temporary}) {\n const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;\n if(shared||temporary||![organizationId,conversationId,versionId].every(x=>typeof x==='string'&&uuid.test(x))||!Array.isArray(rows))return null;\n const matches=rows.filter(row=>row&&row.uuid===versionId);\n if(matches.length!==1)return null;\n const row=matches[0];\n if(row.conversation_uuid!==conversationId||typeof row.artifact_uuid!=='string'||!uuid.test(row.artifact_uuid)||typeof row.artifact_type!=='string'||!row.artifact_type)return null;\n return{organizationId,conversationId,artifactId:row.artifact_uuid,versionId:row.uuid,type:row.artifact_type};\n}";

const linkChatArtifactVersionsSource = `function __claudexLinkChatArtifactVersions(artifact, rows) {
  const byNumber = new Map();
  for (const row of rows ?? []) {
    if (row.artifact_identifier === artifact.id) byNumber.set(row.version_number, row);
  }
  if (!byNumber.size) return artifact;
  const versions = artifact.versions.map((version, index) => {
    const row = byNumber.get(index + 1);
    if (version.uuid || !row || row.message_uuid !== version.message ||
        row.result_state.trimStart() !== version.resultState) return version;
    return { ...version, uuid: row.uuid, version_number: row.version_number };
  });
  return { ...artifact, versions };
}`;

const drawerFile='cbaae0d6d-JY6h84ty.js';
const publishModal='c147e6f61-DfwDuN_w.js';

hostStaticPreviewRules.push(
 {file:drawerFile,name:'chat-artifact-saved-version-identity',before:`function ar(e, t) {
  let $ = J9(5),
    n = J1($, 0, t) ? K1($, 0, t, tr(t)) : $[1];
  return J2($, 2, e, n) ? K2($, 2, e, n, e ? ir(e, n) : er) : $[4];`,after:`${linkChatArtifactVersionsSource}
function ar(e, t) {
  let $ = J9(5),
    n = J1($, 0, t) ? K1($, 0, t, tr(t)) : $[1];
  return J2($, 2, e, n) ? K2($, 2, e, n, e ? ir(__claudexLinkChatArtifactVersions(e, t), n) : er) : $[4];`},
 {file:drawerFile,name:'chat-artifact-review-and-publish-context',before:'function lr(e) {\n  let $ = J9(406),',after:'function lr(e) {\n  const __claudexArtifactContext = __claudexActiveOrganization();\n  const {account: __claudexArtifactAccount} = __claudexArtifactContext;\n  const __claudexPublication = __claudexPublishingCapability(__claudexArtifactContext);\n  let $ = J9(406),'},
 {file:drawerFile,name:'chat-artifact-review-own-saved-markdown',before:'    xi = !!bi && !yi && J?.type === H.Markdown,',after:`    xi = (__claudexArtifactAccount?.claudex_host_authentication?.status !== "authenticated" ||
      __claudexArtifactAccount?.claudex_chat_artifact_review === true) &&
      (!!bi || (__claudexArtifactAccount?.claudex_chat_artifact_review === true &&
      !k && !ne && !Ht && !!S && !!Z && $e && X === J.versions.length - 1)) &&
      !yi && J?.type === H.Markdown,`},
 {file:drawerFile,name:'chat-artifact-reload-versions-after-completion',before:`  (J2($, 106, fn, Ke)
    ? ((Xn = () => {
        if (fn) {
          Yn.current = !0;
          return;
        }
        Yn.current && ((Yn.current = !1), Ke());
      }),
      (Zn = [fn, Ke]),
      K3($, 106, fn, Ke, Xn, Zn))`,after:`  (J2($, 106, r, Ke)
    ? ((Xn = () => {
        if (r) {
          Yn.current = !0;
          return;
        }
        Yn.current && ((Yn.current = !1), Ke());
      }),
      (Zn = [r, Ke]),
      K3($, 106, r, Ke, Xn, Zn))`},
 {file:drawerFile,name:'chat-artifact-published-link-by-version',before:'    Hn = J3($, 93, Nn, Vn, d)',after:`    __claudexPublished = __claudexPublication?.supported && d ? un?.find(row => row.artifact_version_uuid === d && !row.deleted) : undefined,
    Hn = __claudexPublication?.supported ? __claudexPublished?.published_artifact_uuid : J3($, 93, Nn, Vn, d)`},
 {file:drawerFile,name:'chat-artifact-unpublished-version',before:'            ((!!Gn?.published_artifact_uuid && !!Gn.published_artifact_deleted_at) ||',after:'            (!!Gn?.claudex_previously_unpublished || un?.some(row => row.artifact_version_uuid === Gn?.uuid && row.deleted && row.artifact_uuid === Gn?.artifact_uuid) || (!!Gn?.published_artifact_uuid && !!Gn.published_artifact_deleted_at) ||'},
 {file:drawerFile,name:'chat-artifact-publish-exact-saved-version',before:'    sa = Jn ? (je ? "failed" : "pending") : "ok",',after:`    __claudexCanPublish = !k && !ne && !Ht && __claudexPublication?.can_publish === true && Gn?.claudex_can_publish === true,
    sa = __claudexPublication?.supported && !__claudexPublished && !__claudexCanPublish ? "host_unavailable" : Jn ? (je ? "failed" : "pending") : "ok",`},
 {file:drawerFile,name:'chat-artifact-publish-modal-hosted-link',before:`                        publishedArtifactUuid: Hn,
                        liveLinkCount: zt(Vn),
                        liveSandboxRef: R,
                        canPublish: en,`,after:`                        publishedArtifactUuid: Hn,
                        publishedArtifactUrl: __claudexPublished?.url,
                        liveLinkCount: __claudexPublication?.supported ? un?.filter(row => row.artifact_uuid === Z && !row.deleted).length : zt(Vn),
                        liveSandboxRef: R,
                        canPublish: en && (!__claudexPublication?.supported || __claudexCanPublish),`},
 {file:publishModal,name:'chat-artifact-copy-created-hosted-url',before:'                          f(`${h}/public/artifacts/${n}`));',after:'                          f(e.url ?? `${h}/public/artifacts/${n}`));'},
 {file:publishModal,name:'chat-artifact-service-policy',before:'                children: a(w, {\n                  defaultMessage:\n                    "Claudex’s <link>Usage Policy</link>',after:'                children: a(__claudexPublicationPolicy, {children: a(w, {\n                  defaultMessage:\n                    "Claudex’s <link>Usage Policy</link>'},
 {file:publishModal,name:'chat-artifact-service-policy-close',before:'                  values: { link: W },\n                }),',after:'                  values: { link: W },\n                })}),'},
 {file:publishModal,name:'chat-artifact-publish-modal-url-prop',before:'      publishedArtifactUuid: p,\n      liveLinkCount: m,',after:'      publishedArtifactUuid: p,\n      publishedArtifactUrl: __claudexPublishedUrl,\n      liveLinkCount: m,'},
 {file:publishModal,name:'chat-artifact-show-hosted-url',before:'    F = `${x}/public/artifacts/${p}`,',after:'    F = __claudexPublishedUrl ?? `${x}/public/artifacts/${p}`,'},
 {file:publishModal,name:'chat-artifact-manage-hosted-link',before:'            publishedLink: F,\n            surface: "publish_modal",',after:'            publishedLink: F,\n            hostedLink: !!__claudexPublishedUrl,\n            surface: "publish_modal",'},
 {file:publishModal,name:'chat-artifact-native-open-context',before:'function G(e) {\n  let $ = J9(41),',after:`function G(e) {
  const {activeOrganization, account} = __claudexActiveOrganization();
  const {addError} = __claudexUseToast();
  let $ = J9(41),`},
 {file:publishModal,name:'chat-artifact-native-open-link',before:'            href: i,\n            routerOptions: E,',after:`            href: i,
            target: e.hostedLink && account?.claudex_artifact_publishing?.web_open ? "_blank" : undefined,
            rel: e.hostedLink && account?.claudex_artifact_publishing?.web_open ? "noopener noreferrer" : undefined,
            onClick: e.hostedLink && !account?.claudex_artifact_publishing?.web_open ? event => {
              event.preventDefault();
              fetch(\`/api/organizations/\${activeOrganization?.uuid}/published_artifacts/\${t}/open\`, {method:"POST"})
                .then(response => { if (!response.ok) throw Error("Hosted link unavailable"); })
                .catch(() => addError("Couldn’t open this link. Copy it and try opening it in your browser."));
            } : undefined,
            routerOptions: E,`},
 {file:publishModal,name:'chat-artifact-hosted-link-embed-control',before:'    ae = O && v,',after:'    ae = O && v && !__claudexPublishedUrl,'},
 {file:drawerFile,name:'chat-artifact-publish-host-capability',before:'function yr(t) {\n  let $ = J9(329),',after:'function yr(t) {\n  const __claudexPublishBlocked=__claudexPublishingUnavailable(__claudexActiveOrganization());\n  let $ = J9(329),'},
 {file:drawerFile,name:'chat-artifact-publish-check-and-action',before:'      publishCheck: le,\n      publishedArtifactUuid: B,\n      projectParams: ue,\n      onClose: de,\n      openPublishModal: fe,',after:'      publishCheck: __claudexOriginalPublishCheck,\n      publishedArtifactUuid: B,\n      projectParams: ue,\n      onClose: de,\n      openPublishModal: __claudexOriginalPublishOpen,'},
 {file:drawerFile,name:'chat-artifact-publish-memo-inputs',before:'    } = t,\n    U = Je(),\n    ye = yt("toolResultMarkersTrusted"),',after:'    } = t,\n    le = __claudexPublishBlocked ? "host_unavailable" : __claudexOriginalPublishCheck,\n    fe = __claudexPublishBlocked ? __claudexBlockedPublish : __claudexOriginalPublishOpen,\n    U = Je(),\n    ye = yt("toolResultMarkersTrusted"),'},
 {file:drawerFile,name:'chat-artifact-publish-visible-reason',before:'  return J2($, 326, bt, xt) ? K2($, 326, bt, xt, c(l, { children: [bt, xt] })) : $[328];\n}\nfunction br(e) {',after:'  return g(__claudexPublishingNotice,{blocked:__claudexPublishBlocked,children:(J2($, 326, bt, xt) ? K2($, 326, bt, xt, c(l, { children: [bt, xt] })) : $[328])});\n}\nfunction br(e) {'}
);

const sha=x=>createHash('sha256').update(x).digest('hex');
export function deriveOfficialUiHostStaticPreviewModule(name,source){if(!Object.hasOwn(hostStaticPreviewInputHashes,name))return source;if(sha(source)!==hostStaticPreviewInputHashes[name])throw Error('Pinned static preview checksum mismatch: '+name);let next=source;for(const r of hostStaticPreviewRules.filter(r=>r.file===name)){const i=next.indexOf(r.before);if(i<0||next.indexOf(r.before,i+r.before.length)!==-1)throw Error('Pinned static preview anchor mismatch: '+r.name);next=next.slice(0,i)+r.after+next.slice(i+r.before.length);}return (name===drawerFile?'import {publishingCapability as __claudexPublishingCapability,publishingUnavailable as __claudexPublishingUnavailable,blockedPublish as __claudexBlockedPublish,PublishingUnavailableNotice as __claudexPublishingNotice} from "./claudex-host-artifact-publishing.js";\nimport {Q6 as __claudexActiveOrganization} from "./shared-l-p-m-w-2-BMCa56Vr.js";\n':name===publishModal?'import {PublicationPolicy as __claudexPublicationPolicy} from "./claudex-host-artifact-publishing.js";\nimport {Q6 as __claudexActiveOrganization,oS as __claudexUseToast} from "./shared-l-p-m-w-2-BMCa56Vr.js";\n':'')+next;}
export function applyOfficialUiHostStaticPreview(directory){directory=fs.realpathSync(directory);if(directory.split(path.sep).includes('.restore'))throw Error('Recovered sources are immutable');const rows=Object.keys(hostStaticPreviewInputHashes).map(file=>{const target=path.join(directory,file);if(fs.lstatSync(target).isSymbolicLink())throw Error('Symlink output rejected');const input=fs.readFileSync(target,'utf8');return{file,target,input,output:deriveOfficialUiHostStaticPreviewModule(file,input)};});for(const r of rows)fs.writeFileSync(r.target,r.output);return{revision:hostStaticPreviewRevision,modules:rows.map(r=>({file:r.file,originalSha256:hostStaticPreviewOriginalHashes[r.file],inputSha256:sha(r.input),outputSha256:sha(r.output),rules:hostStaticPreviewRules.filter(x=>x.file===r.file).map(x=>x.name)}))};}
