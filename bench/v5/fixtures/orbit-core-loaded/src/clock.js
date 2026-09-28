// 시뮬레이션 시계. 지금은 경과 시간을 그냥 스텝 수로 나눠 쓰고 있어서 나머지 시간이 버려지고,
// pause()/resume()/setTimeScale()은 자리만 잡아둔 상태다.
export const createClock = ({ stepMs = 16 } = {}) => {
  let simTimeMs = 0;

  return {
    advance(elapsedMs) {
      const steps = Math.floor(elapsedMs / stepMs);
      simTimeMs += steps * stepMs;
      return steps;
    },
    pause() {},
    resume() {},
    setTimeScale() {},
    state: () => ({ simTimeMs }),
  };
};
