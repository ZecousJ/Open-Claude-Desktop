import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSideQuestionError, sideQuestionErrorCode, sideQuestionErrorText } from '../shared/side-question-errors.mjs';
const response = message => ({type:'error',error:{type:'invalid_request_error',message}});
const intl = locale => ({locale,formatMessage:({defaultMessage})=>defaultMessage});
test('known side-question context failures get bounded actionable text',()=>{
  const code=sideQuestionErrorCode(409,response('A side-question attachment is unavailable or changed.'));
  assert.equal(code,'attachment');
  assert.match(sideQuestionErrorText({claudexSideQuestionCode:code},intl('zh-CN')),/文件.*不可用|文件.*变化/);
  assert.match(sideQuestionErrorText({claudexSideQuestionCode:code},intl('en-US')),/file.*unavailable|file.*changed/i);
  assert.equal(sideQuestionErrorCode(409,response('The side-question history is too large.')),'size');
  assert.equal(sideQuestionErrorCode(409,response('This side-question history contains unsupported content.')),'history');
});
test('unknown or untrusted errors remain generic and cannot reflect arbitrary text',()=>{
  for(const [status,value] of [[500,response('A side-question attachment is unavailable or changed.')],[409,response('/secret/user/path')],[409,{error:{message:'A side-question attachment is unavailable or changed.'}}]])assert.equal(sideQuestionErrorCode(status,value),undefined);
  assert.equal(sideQuestionErrorText({message:'/secret/user/path',claudexSideQuestionCode:'forged'},intl('en-US')),'Something went wrong');
  assert.equal(publicSideQuestionError(Object.defineProperty({}, 'message', {get(){throw Error('private')}})), 'The side question could not be started.');
});
