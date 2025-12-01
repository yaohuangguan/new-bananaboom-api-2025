module.exports = () => {
  const temp = new Date();
  const year = temp.getFullYear() + "/";
  const month =
    (temp.getMonth() + 1 < 10
      ? "0" + (temp.getMonth() + 1)
      : temp.getMonth() + 1) + "/";
  const day =
    (temp.getDate() < 10 ? "0" + temp.getDate() : temp.getDate()) + " ";
  const hours =
    (temp.getHours() < 10 ? "0" + temp.getHours() : temp.getHours()) + ":";
  const min =
    (temp.getMinutes() < 10 ? "0" + temp.getMinutes() : temp.getMinutes()) + "";
  return year + month + day + hours + min;
};
