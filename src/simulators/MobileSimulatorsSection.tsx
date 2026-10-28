import { preference } from "../../shared/settings-extras";
import { simulatorSupported } from "../../shared/simulators";
import { useHost } from "../host/HostContext";
import { Row, Section, Toggle } from "../settings/controls";
import type { TabProps } from "../settings/context";

/**
 * Settings → Claude Code → Mobile simulators: one switch for the iOS Simulator
 * (a Mac) and one for the Android Emulator (a Mac or Windows). On, Claude gets
 * its device tools in Code sessions and is asked before it first uses each
 * device; off, Claude gets no tools and the panes still work for you. A kind
 * this computer can't run has no row, and without either the section is not
 * drawn.
 */
export function MobileSimulatorsSection({
  settings,
  save,
  platform,
}: Pick<TabProps, "settings" | "save" | "platform">) {
  const desktop = useHost().kind === "desktop";
  const ios = desktop && simulatorSupported("ios", platform);
  const android = desktop && simulatorSupported("android", platform);
  if (!ios && !android) return null;
  return (
    <Section title="Mobile simulators">
      {ios && (
        <Row
          label="iOS Simulator"
          description="Let Claudex verify your changes in the iOS Simulator on this Mac: running your app, driving it through flows, and capturing screenshots and recordings. You will be asked before Claudex uses each device. When off, Claudex doesn’t get its simulator tools, and you can still use the simulator in the app yourself."
        >
          <Toggle
            label="iOS Simulator"
            checked={preference(settings, "iosSimulatorAccess")}
            onChange={(iosSimulatorAccess) => save({ iosSimulatorAccess })}
          />
        </Row>
      )}
      {android && (
        <Row
          label="Android Emulator"
          description={
            platform === "darwin"
              ? "Let Claudex verify your changes in Android emulators on this Mac: running your app, driving it through flows, and capturing screenshots and recordings. You will be asked before Claudex uses each device. When off, Claudex doesn’t get its emulator tools, and you can still use the emulator in the app yourself."
              : "Let Claudex verify your changes in Android emulators on this computer: running your app, driving it through flows, and capturing screenshots and recordings. You will be asked before Claudex uses each device. When off, Claudex doesn’t get its emulator tools, and you can still use the emulator in the app yourself."
          }
        >
          <Toggle
            label="Android Emulator"
            checked={preference(settings, "androidEmulatorAccess")}
            onChange={(androidEmulatorAccess) =>
              save({ androidEmulatorAccess })
            }
          />
        </Row>
      )}
    </Section>
  );
}
