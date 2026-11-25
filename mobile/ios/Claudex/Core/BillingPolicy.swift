import Foundation

/// The account's monthly spend cap and a redeem code, as the service reports them.
public enum BillingPolicy {
    public struct Spend: Equatable, Sendable {
        public let limitUsd: Double?
        public let usedUsd: Double
        public let resetsAt: String
    }
    public struct Redeemed: Equatable, Sendable {
        public let type: String
        public let value: Double
        public let plan: String
        public let days: Int
    }

    /// 20 or 20.50, with an optional dollar sign. Nil when it is not an amount this account can save.
    public static func parseAmount(_ text: String) -> Double? {
        let value = text.replacingOccurrences(of: "[$,\\s]", with: "", options: .regularExpression)
        guard value.range(of: #"^\d+(\.\d{1,2})?$"#, options: .regularExpression) != nil,
              let number = Double(value), number.isFinite, number <= 100_000 else { return nil }
        return number
    }

    public static func money(_ value: Double, whole: Bool = false) -> String {
        if whole, value.truncatingRemainder(dividingBy: 1) == 0 { return "$\(Int(value))" }
        return String(format: "$%.2f", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    /// The spend-limit document, or nil when the service did not return one.
    public static func spend(_ data: JSONValue) -> Spend? {
        guard data["currency"].string == "USD", data.object?["limit_usd"] != nil, data.object?["used_usd"] != nil,
              let used = data["used_usd"].number, used.isFinite, used >= 0 else { return nil }
        let raw = data["limit_usd"]
        let limit: Double?
        if raw == .null { limit = nil }
        else if let number = raw.number, number.isFinite, number >= 0, number <= 100_000 { limit = number }
        else { return nil }
        guard let resets = data["resets_at"].string, validReset(resets) else { return nil }
        return Spend(limitUsd: limit, usedUsd: used, resetsAt: resets)
    }

    public static func acceptsCode(_ raw: String) -> Bool {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^[A-Za-z0-9_-]{4,128}$"#, options: .regularExpression) != nil
    }

    public static func redeemed(_ data: JSONValue) -> Redeemed? {
        guard let type = data["type"].string else { return nil }
        let value = data["value"].number ?? 0
        return Redeemed(
            type: type,
            value: value.isFinite && value >= 0 ? value : 0,
            plan: data["group"]["name"].string ?? "",
            days: max(0, data["validity_days"].integer ?? 0))
    }

    /// A known redeem refusal. Anything else stays with the caller.
    public static func redeemProblem(_ code: String) -> String? {
        switch code {
        case "REDEEM_CODE_NOT_FOUND": "missing"
        case "REDEEM_CODE_USED": "used"
        case "REDEEM_CODE_EXPIRED": "expired"
        case "REDEEM_CODE_LOCKED": "locked"
        case "REDEEM_RATE_LIMITED": "limited"
        default: nil
        }
    }

    public static func validReset(_ value: String) -> Bool {
        guard value.count <= 64,
              let match = value.wholeMatch(of: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
        else { return false }
        let parts = match.output
        let year = Int(parts.1) ?? 0
        let month = Int(parts.2) ?? 0
        let day = Int(parts.3) ?? 0
        let hour = Int(parts.4) ?? 0
        let minute = Int(parts.5) ?? 0
        let second = Int(parts.6) ?? 0
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard (1...12).contains(month), (1...lengths[month - 1]).contains(day), hour < 24, minute < 60, second < 60 else { return false }
        return true
    }

    public struct PayMethod: Equatable, Sendable {
        public let id: String
        public let currency: String
        public let min: Double
        public let max: Double
        public let browser: Bool
    }
    public struct Checkout: Equatable, Sendable {
        public let methods: [PayMethod]
        public let balance: Bool
        public let min: Double
        public let max: Double
    }
    public enum PayLaunch: Equatable, Sendable {
        case open(String)
        case qr(String)
        case checkout(orderId: Int, resume: String, secret: String, intent: String, currency: String, country: String, env: String)
        case unavailable(String, hide: Bool)
    }

    private static let aliases = ["alipay": "alipay", "alipay_direct": "alipay", "wxpay": "wxpay", "wxpay_direct": "wxpay", "stripe": "stripe", "airwallex": "airwallex"]
    private static let methodOrder = ["alipay", "wxpay", "stripe", "airwallex"]
    private static let browserMethods: Set<String> = ["stripe", "airwallex"]

    /// Methods this app can pay with. Card methods need the service's browser checkout.
    public static func checkout(_ info: JSONValue, desktopCheckout: Bool) -> Checkout? {
        guard let methods = info["methods"].object else { return nil }
        var found: [String: PayMethod] = [:]
        for (key, raw) in methods {
            guard let item = raw.object else { continue }
            let named = item["payment_type"]?.string ?? ""
            let type = String((named.isEmpty ? key : named).prefix(40))
            guard let id = aliases[type] else { continue }
            if browserMethods.contains(id), !desktopCheckout { continue }
            let canonical = type == id
            if found[id] != nil, !canonical { continue }
            let code = (item["currency"]?.string ?? "").trimmingCharacters(in: .whitespaces).uppercased()
            let currency = code.range(of: #"^[A-Z]{3}$"#, options: .regularExpression) != nil ? code : "CNY"
            found[id] = PayMethod(id: id, currency: currency, min: max(0, item["single_min"]?.number ?? 0), max: max(0, item["single_max"]?.number ?? 0), browser: browserMethods.contains(id))
        }
        let listed = methodOrder.compactMap { found[$0] }
        guard !listed.isEmpty else { return nil }
        return Checkout(methods: listed, balance: info["balance_disabled"].bool != true, min: max(0, info["global_min"].number ?? 0), max: max(0, info["global_max"].number ?? 0))
    }

    /// Why this top-up cannot be ordered, or nil when the amount is acceptable.
    public static func amountProblem(_ amount: Double?, method: PayMethod, floor: Double, ceiling: Double) -> String? {
        guard let amount, amount.isFinite, amount > 0 else { return "empty" }
        let min = max(method.min, floor)
        let caps = [method.max, ceiling].filter { $0 > 0 }
        let maxAmount = caps.min() ?? .infinity
        if min > 0, amount < min { return "low" }
        if amount > maxAmount { return "high" }
        return nil
    }

    /// How to pay an order the service just created. A client secret never becomes part of a URL.
    public static func launch(_ order: JSONValue, desktopCheckout: Bool) -> PayLaunch {
        if let secret = order["client_secret"].string, !secret.isEmpty {
            let resume = order["resume_token"].string ?? ""
            let orderId = order["order_id"].integer ?? 0
            if !desktopCheckout || resume.isEmpty || orderId <= 0 { return .unavailable("desktop", hide: true) }
            return .checkout(orderId: orderId, resume: resume, secret: secret, intent: order["intent_id"].string ?? "", currency: order["currency"].string ?? "", country: order["country_code"].string ?? "", env: order["payment_env"].string ?? "")
        }
        let result = order["result_type"].string ?? ""
        if result == "oauth_required" || result == "jsapi_ready" { return .unavailable("wechat", hide: true) }
        let mode = (order["payment_mode"].string ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let redirect = mode == "redirect" || mode == "popup"
        let qr = order["qr_code"].string ?? ""
        let page = order["pay_url"].string ?? ""
        if !qr.isEmpty, !(redirect && !page.isEmpty) { return .qr(String(qr.prefix(4000))) }
        if !page.isEmpty { return httpsUrl(page, max: 4000).map(PayLaunch.open) ?? .unavailable("insecure", hide: false) }
        return .unavailable("unknown", hide: false)
    }

    /// The service's browser checkout page. The token is the only thing added, and only as the fragment.
    public static func desktopPay(origin: String, token: String) -> String? {
        guard token.range(of: #"^[A-Za-z0-9_-]{16,200}$"#, options: .regularExpression) != nil,
              let root = httpsUrl(origin.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/")), max: 2000)
        else { return nil }
        return root + "/desktop-pay#t=" + token
    }

    /// The payment routes the phone may call. A client secret is only posted to the checkout-link route.
    public static func allowsPayment(path: String, method: String, query: [String: String], body: JSONValue?) -> Bool {
        if path == "api/v1/payment/config" || path == "api/v1/payment/checkout-info" { return method == "GET" && body == nil && query.isEmpty }
        if path == "api/v1/payment/orders" {
            guard method == "POST", query.isEmpty, let fields = body?.object else { return false }
            let names = Set(fields.keys)
            guard names.isSubset(of: ["payment_type", "order_type", "amount", "return_url", "payment_source", "is_mobile"]),
                  fields["order_type"]?.string == "balance", fields["payment_source"]?.string == "hosted_redirect", fields["is_mobile"]?.bool == true,
                  let type = fields["payment_type"]?.string, ["alipay", "wxpay", "stripe", "airwallex"].contains(type),
                  let amount = fields["amount"]?.number, amount > 0, amount <= 1_000_000,
                  let back = fields["return_url"]?.string, httpsUrl(back) != nil else { return false }
            return true
        }
        if path == "api/v1/claudex/payment/checkout-links" {
            guard method == "POST", query.isEmpty, let fields = body?.object else { return false }
            let names = Set(fields.keys)
            let required: Set<String> = ["order_id", "resume_token", "client_secret"]
            return required.isSubset(of: names) && names.isSubset(of: required.union(["intent_id", "currency", "country_code", "payment_env"]))
                && (fields["order_id"]?.integer ?? 0) > 0 && !(fields["resume_token"]?.string ?? "").isEmpty && !(fields["client_secret"]?.string ?? "").isEmpty
        }
        guard let match = path.wholeMatch(of: /^api\/v1\/payment\/orders\/(\d{1,18})(\/cancel)?$/) else { return false }
        let cancel = match.output.2.map(String.init)?.isEmpty == false
        return query.isEmpty && body == nil && method == (cancel ? "POST" : "GET")
    }

    public static func httpsUrl(_ value: String, max: Int = 2000) -> String? {
        guard !value.isEmpty, value.count <= max, let url = URL(string: value), url.scheme == "https",
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return value
    }
}
