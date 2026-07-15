const loadSignClientModule = async () => {
  process.env["DISABLE_GLOBAL_CORE"] = "true";
  return require("@walletconnect/sign-client");
};

const loadQrCodeModule = async () => require("qrcode");

module.exports = Object.freeze({ loadQrCodeModule, loadSignClientModule });
