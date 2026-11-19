// Native authorization (live claude.ai bundle, 2026-10-14, index.chunk-BWk6pVUt, getAuthorizationStatus).
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

static constexpr char interrupted[] = "NOTIFICATION_AUTHORIZATION_INTERRUPTED";

static void RejectAuthorization(napi_env env, napi_deferred deferred) {
  napi_value message, error;
  if (napi_create_string_utf8(env, interrupted, NAPI_AUTO_LENGTH, &message) == napi_ok &&
      napi_create_error(env, nullptr, message, &error) == napi_ok)
    napi_reject_deferred(env, deferred, error);
}

static void ResolveAuthorization(napi_env env, napi_value, void *context, void *data) {
  if (!env) return;
  auto deferred = static_cast<napi_deferred>(context);
  napi_value result;
  if (napi_create_string_utf8(env, static_cast<const char *>(data), NAPI_AUTO_LENGTH, &result) == napi_ok)
    napi_resolve_deferred(env, deferred, result);
  else
    RejectAuthorization(env, deferred);
}

static void DeliverAuthorization(napi_threadsafe_function callback, const char *result) {
  // A closing queue releases this producer itself.
  if (napi_call_threadsafe_function(callback, const_cast<char *>(result), napi_tsfn_nonblocking) == napi_ok)
    napi_release_threadsafe_function(callback, napi_tsfn_release);
}

static napi_value Authorization(napi_env env, napi_callback_info info) {
  void *mode;
  napi_value promise, name;
  napi_deferred deferred;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode) != napi_ok ||
      napi_create_string_utf8(env, "notification-authorization", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_promise(env, &deferred, &promise) != napi_ok) {
    napi_throw_error(env, nullptr, interrupted);
    return nullptr;
  }

  napi_threadsafe_function callback;
  if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr,
                                      nullptr, deferred, ResolveAuthorization, &callback) != napi_ok) {
    RejectAuthorization(env, deferred);
    return promise;
  }
  napi_unref_threadsafe_function(env, callback);

  @try {
    auto center = [UNUserNotificationCenter currentNotificationCenter];
    if (mode) {
      [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionBadge | UNAuthorizationOptionSound
                           completionHandler:^(BOOL granted, NSError *error) {
        if (error) NSLog(@"Claudex notification authorization failed (%@ %ld)", error.domain, (long)error.code);
        DeliverAuthorization(callback, error ? "error" : granted ? "granted" : "denied");
      }];
    } else {
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        const char *status;
        switch (settings.authorizationStatus) {
          case UNAuthorizationStatusAuthorized: status = "authorized"; break;
          case UNAuthorizationStatusDenied: status = "denied"; break;
          case UNAuthorizationStatusProvisional: status = "provisional"; break;
          default: status = "notDetermined"; break;
        }
        DeliverAuthorization(callback, status);
      }];
    }
  } @catch (NSException *exception) {
    napi_release_threadsafe_function(callback, napi_tsfn_abort);
    RejectAuthorization(env, deferred);
  }
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
