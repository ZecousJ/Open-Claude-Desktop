import XCTest
@testable import ClaudexCore

final class BillingPolicyTests: XCTestCase {
    func testAnAmountIsDollarsWithAtMostTwoDecimals() {
        XCTAssertEqual(BillingPolicy.parseAmount("20"), 20)
        XCTAssertEqual(BillingPolicy.parseAmount("$20.50"), 20.5)
        XCTAssertNil(BillingPolicy.parseAmount("20.555"))
        XCTAssertNil(BillingPolicy.parseAmount("100001"))
        XCTAssertEqual(BillingPolicy.money(20, whole: true), "$20")
        XCTAssertEqual(BillingPolicy.money(12.3), "$12.30")
    }

    func testTheSpendDocumentMustNameUsdAndARealReset() {
        let kept = BillingPolicy.spend(.object([
            "limit_usd": .number(20), "used_usd": .number(1.5), "resets_at": .string("2026-12-01T00:00:00Z"), "currency": .string("USD"),
        ]))
        XCTAssertEqual(kept?.limitUsd, 20)
        let foreign = BillingPolicy.spend(.object([
            "limit_usd": .null, "used_usd": .number(1), "resets_at": .string("2026-12-01T00:00:00Z"), "currency": .string("EUR"),
        ]))
        XCTAssertNil(foreign)
        let open = BillingPolicy.spend(.object([
            "limit_usd": .null, "used_usd": .number(0), "resets_at": .string("2024-02-29T00:00:00Z"), "currency": .string("USD"),
        ]))
        XCTAssertNil(open?.limitUsd)
        XCTAssertNotNil(open)
        XCTAssertFalse(BillingPolicy.validReset("2025-02-29T00:00:00Z"))
    }

    func testARedeemCodeIsTheCharactersTheServiceIssued() {
        XCTAssertTrue(BillingPolicy.acceptsCode(" AB_12 "))
        XCTAssertFalse(BillingPolicy.acceptsCode("abc"))
        XCTAssertFalse(BillingPolicy.acceptsCode("../secret"))
        let redeemed = BillingPolicy.redeemed(.object(["type": .string("balance"), "value": .number(5), "validity_days": .number(0)]))
        XCTAssertEqual(redeemed?.type, "balance")
        XCTAssertEqual(BillingPolicy.redeemProblem("REDEEM_CODE_NOT_FOUND"), "missing")
        XCTAssertNil(BillingPolicy.redeemProblem("OTHER"))
    }

    func testCardCheckoutStaysOffUntilTheServiceServesIt() {
        let info = JSONValue.object([
            "methods": .object([
                "stripe": .object(["payment_type": .string("stripe"), "currency": .string("usd"), "single_min": .number(1), "single_max": .number(100)]),
                "alipay_direct": .object(["payment_type": .string("alipay_direct"), "currency": .string("CNY"), "single_min": .number(10), "single_max": .number(0)]),
            ]),
            "global_min": .number(0), "global_max": .number(0),
        ])
        XCTAssertEqual(BillingPolicy.checkout(info, desktopCheckout: false)?.methods.map(\.id), ["alipay"])
        XCTAssertEqual(BillingPolicy.checkout(info, desktopCheckout: true)?.methods.map(\.id), ["alipay", "stripe"])
        let alipay = BillingPolicy.checkout(info, desktopCheckout: false)!.methods[0]
        XCTAssertEqual(BillingPolicy.amountProblem(5, method: alipay, floor: 0, ceiling: 0), "low")
        XCTAssertNil(BillingPolicy.amountProblem(10, method: alipay, floor: 0, ceiling: 0))
    }

    func testAPaymentPageMustBeHttpsAndASecretNeverJoinsTheUrl() {
        if case .unavailable(let reason, _) = BillingPolicy.launch(.object(["pay_url": .string("http://pay.example/checkout")]), desktopCheckout: false) {
            XCTAssertEqual(reason, "insecure")
        } else { XCTFail("an http page was accepted") }
        if case .open(let url) = BillingPolicy.launch(.object(["pay_url": .string("https://pay.example/checkout")]), desktopCheckout: false) {
            XCTAssertEqual(url, "https://pay.example/checkout")
        } else { XCTFail("an https page was refused") }
        if case .unavailable(let reason, let hide) = BillingPolicy.launch(.object(["client_secret": .string("sekret"), "resume_token": .string("resume"), "order_id": .number(4)]), desktopCheckout: false) {
            XCTAssertEqual(reason, "desktop")
            XCTAssertTrue(hide)
        } else { XCTFail("a secret was turned into a page") }
        XCTAssertEqual(BillingPolicy.desktopPay(origin: "https://claudex.example", token: "abcdefghijklmnop"), "https://claudex.example/desktop-pay#t=abcdefghijklmnop")
        XCTAssertNil(BillingPolicy.desktopPay(origin: "http://claudex.example", token: "abcdefghijklmnop"))
    }
}
