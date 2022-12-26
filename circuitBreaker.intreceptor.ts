class InternalServerError extends Error {
  status = 500;
}

type CircuitBreakerDataStructure = {
  readonly timeout: number;
  readonly maxRequest: number;
  readonly failedPercentage: number;
  readonly acceptableTimeOut: number;
  readonly halfOpenPercentage: number;
  readonly halfToCloseMinPercentage: number;
  readonly halfOpenMaxRequests: number;
  state: "close" | "half" | "open";
  lastRequestTime: Date;
  counter: number;
  unsuccessfulCount: number;
  consecutiveOpenCircuitCount: number;
};

export class CircuitBreakerInterceptor {
  private static circuitBreakerServices = ["http://10.0.200.220:5000"];

  private static BaseCircuitBreakerData: CircuitBreakerDataStructure = {
    timeout: 10 * 1000,
    maxRequest: 50,
    failedPercentage: 40,
    halfOpenPercentage: 10,
    halfOpenMaxRequests: 100,
    halfToCloseMinPercentage: 80,
    acceptableTimeOut: 4500,
    state: "close",
    counter: 0,
    unsuccessfulCount: 0,
    lastRequestTime: new Date(),
    consecutiveOpenCircuitCount: 0,
  };

  private static serviceData = {};
  private static changeStateCallback: (
    from: "close" | "half" | "open",
    to: "close" | "half" | "open",
    originName: string
  ) => void;

  public static setChangeStateCallback(
    callback: (
      from: "close" | "half" | "open",
      to: "close" | "half" | "open",
      originName: string
    ) => void
  ) {
    CircuitBreakerInterceptor.changeStateCallback = callback;
  }

  static requestInterceptor(config) {
    try {
      const origin = new URL(config.url).origin;
      if (CircuitBreakerInterceptor.circuitBreakerServices.includes(origin)) {
        config.metadata = { startTime: new Date() };
        let originData: CircuitBreakerDataStructure =
          CircuitBreakerInterceptor.serviceData[origin];

        if (!originData) {
          CircuitBreakerInterceptor.serviceData[origin] =
            CircuitBreakerInterceptor.BaseCircuitBreakerData;
          originData = CircuitBreakerInterceptor.serviceData[origin];
        }
        console.log(originData.state);
        originData.counter++;

        if (originData.state === "open") {
          CircuitBreakerInterceptor.open(originData, origin);
        } else if (originData.state === "half") {
          CircuitBreakerInterceptor.half(originData, origin);
        }
      }

      return config;
    } catch (e) {
      e.config = config;
      throw e;
    }
  }

  protected static half(
    originData: CircuitBreakerDataStructure,
    originName: string
  ) {
    if (originData.counter >= originData.halfOpenMaxRequests) {
      const requestCounts =
        (originData.halfOpenMaxRequests * originData.halfOpenPercentage) / 100;
      const realUnsuccessfulCount =
        originData.unsuccessfulCount -
        (originData.halfOpenMaxRequests - requestCounts);
      if (
        requestCounts - realUnsuccessfulCount >
        (requestCounts * originData.halfToCloseMinPercentage) / 100
      ) {
        CircuitBreakerInterceptor.changeState(
          "half",
          "close",
          originName,
          originData
        );
      } else {
        CircuitBreakerInterceptor.changeState(
          "half",
          "open",
          originName,
          originData
        );
      }
    }

    if (originData.counter % (100 / originData.halfOpenPercentage) === 0) {
      return;
    }
    throw new InternalServerError();
  }

  protected static open(
    originData: CircuitBreakerDataStructure,
    originName: string
  ) {
    if (
      originData.lastRequestTime.getTime() +
        originData.timeout * 2 ** originData.consecutiveOpenCircuitCount <
      new Date().getTime()
    ) {
      CircuitBreakerInterceptor.changeState(
        "open",
        "half",
        originName,
        originData
      );
    }
    throw new InternalServerError();
  }

  static responseInterceptor(response) {
    response.config.metadata.endTime = new Date();
    response.duration =
      response.config.metadata.endTime - response.config.metadata.startTime;

    return response;
  }

  protected static changeState(
    from: "close" | "half" | "open",
    to: "close" | "half" | "open",
    originName: string,
    originData: CircuitBreakerDataStructure
  ) {
    if (from === to) {
      throw new Error();
    }

    originData.state = to;
    originData.counter = 0;
    originData.unsuccessfulCount = 0;
    originData.lastRequestTime = new Date();

    if (from === "half" && to === "open") {
      originData.consecutiveOpenCircuitCount++;
      console.log(originData.consecutiveOpenCircuitCount);
    } else if (from === "open" && to === "half") {
    } else {
      originData.consecutiveOpenCircuitCount = 0;
    }

    if (CircuitBreakerInterceptor.changeStateCallback)
      return CircuitBreakerInterceptor.changeStateCallback(
        from,
        to,
        originName
      );
    return;
  }

  static responseErrorInterceptor(error) {
    const origin = new URL(error.config?.url || error.url).origin;
    const status = error.response?.status || null;

    if (
      (status === null || status % 500 < 100) &&
      CircuitBreakerInterceptor.circuitBreakerServices.includes(origin)
    ) {
      let originData: CircuitBreakerDataStructure =
        CircuitBreakerInterceptor.serviceData[origin];
      console.log(
        originData.failedPercentage,
        originData.unsuccessfulCount,
        originData.maxRequest,
        originData.counter
      );
      originData.unsuccessfulCount++;

      if (originData.state === "close") {
        if (
          originData.failedPercentage <
          (originData.unsuccessfulCount / originData.maxRequest) * 100
        ) {
          CircuitBreakerInterceptor.changeState(
            "close",
            "open",
            origin,
            originData
          );
        }
      }
    }
    return error;
  }
}
