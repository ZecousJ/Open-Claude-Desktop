import landing from './landing'
import common from './common'
import dashboard from './dashboard'
import channelMonitorV2 from './channelMonitorV2'
import batchImage from './batchImage'
import admin from './admin'
import misc from './misc'
import desktopOnly from './desktopOnly' // CLAUDEX
import desktopCheckout from './desktopCheckout' // CLAUDEX
import claudexPublic from './claudexPublic' // CLAUDEX: LOGIN

export default {
  ...landing,
  ...common,
  ...dashboard,
  ...channelMonitorV2,
  ...batchImage,
  admin,
  ...misc,
  ...desktopOnly, // CLAUDEX
  ...desktopCheckout, // CLAUDEX
  ...claudexPublic, // CLAUDEX: LOGIN
}
