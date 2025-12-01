const express = require("express");
const router = express.Router();
const fetch = require("isomorphic-unfetch");
// router.get(
//   "/google",
//   passport.authenticate("google", {
//     scope: ["profile", "email"]
//   })
// );

// router.get("/google/callback", passport.authenticate("google"), (req, res) => {
//   res.redirect("/auth/current_user");
// });
// router.get("/current_user", (req, res) => {
//   res.send(req.user);
// });

router.get("/logout", (req, res) => {
  req.logout();
  res.send(req.user);
});
router.post("/subscribe", async (req, res) => {
  const { email } = req.body;
  const data = {
    members: [
      {
        email_address: email,
        status: "subscribed"
      }
    ]
  };
  const dataString = JSON.stringify(data);
  try {
    const response = await fetch(
      "https://us20.api.mailchimp.com/3.0/lists/4b2f990265",
      {
        method: "post",
        headers: {
          Authorization: process.env.MAILCHIMP_API_KEY
        },
        body: dataString
      }
    );
    const data = await response.json();
    console.log(data);
    if (data.status === 404) {
      return res.json({
        message: "Server error. Please retry later.",
        message_cn: "订阅失败，请重试。",
        status: "fail"
      });
    } else if (data.status === 403) {
      return res.json({
        message: "Server error. Please retry later.",
        message_cn: "订阅失败，请重试。",
        status: "fail"
      });
    }
    if (!data.total_created) {
      res.json({
        message: "You can not subscribe my list multiple times.",
        message_cn: "这个邮箱已经订阅，请勿重复订阅。",
        status: "fail"
      });
    } else {
      res.json({
        message: "All good! Subscribed Successfully!",
        message_cn: "订阅成功！",
        status: "success"
      });
    }
  } catch (error) {
    console.log(error);
    res
      .status(400)
      .json({
        message: "Something wrong. Please try again later.",
        message_cn: "订阅失败，请重试。",
        status: "fail"
      });
  }
});

module.exports = router;
