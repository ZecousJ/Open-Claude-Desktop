// Native notification authorization status.
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <string>

struct AuthorizationRequest {
  napi_deferred deferred;
  napi_async_work work;
  bool request;
  bool failed;
  std::string result;
};

static void ExecuteAuthorization(napi_env env, void *data) {
  auto *request = static_cast<AuthorizationRequest *>(data);
  @autoreleasepool {
    @try {
    auto semaphore = dispatch_semaphore_create(0);
    auto center = [UNUserNotificationCenter currentNotificationCenter];
    if (request->request) {
      [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionBadge | UNAuthorizationOptionSound
                           completionHandler:^(BOOL granted, NSError *error) {
        request->result = error ? "error" : granted ? "granted" : "denied";
        dispatch_semaphore_signal(semaphore);
      }];
    } else {
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        switch (settings.authorizationStatus) {
          case UNAuthorizationStatusAuthorized: request->result = "authorized"; break;
          case UNAuthorizationStatusDenied: request->result = "denied"; break;
          case UNAuthorizationStatusProvisional: request->result = "provisional"; break;
          default: request->result = "notDetermined"; break;
        }
        dispatch_semaphore_signal(semaphore);
      }];
    }
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    } @catch (NSException *exception) {
      request->failed = true;
    }
  }
}

static void CompleteAuthorization(napi_env env, napi_status status, void *data) {
  auto *request = static_cast<AuthorizationRequest *>(data);
  napi_value result;
  if (status == napi_ok && !request->failed) {
    napi_create_string_utf8(env, request->result.c_str(), NAPI_AUTO_LENGTH, &result);
    napi_resolve_deferred(env, request->deferred, result);
  } else {
    napi_value message;
    napi_create_string_utf8(env, "NOTIFICATION_AUTHORIZATION_INTERRUPTED", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &result);
    napi_reject_deferred(env, request->deferred, result);
  }
  napi_delete_async_work(env, request->work);
  delete request;
}

static napi_value Authorization(napi_env env, napi_callback_info info) {
  void *mode;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode);
  auto *request = new AuthorizationRequest{};
  request->request = mode != nullptr;
  napi_value promise, name;
  napi_create_promise(env, &request->deferred, &promise);
  napi_create_string_utf8(env, "notification-authorization", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, ExecuteAuthorization, CompleteAuthorization, request, &request->work);
  napi_queue_async_work(env, request->work);
  return promise;
}

static napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"getAuthorizationStatus", nullptr, Authorization, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requestAuthorization", nullptr, Authorization, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void *>(1)},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
